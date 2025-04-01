"use strict";

// Purpose: Calculate semantic compatibility score between two notes.
// Combines property-based matching and optional vector-based matching.

import {Utils} from './util.js';
import { SLOT_EDITOR_PLUGIN_PANELS, SLOT_SETTINGS_PANEL_SECTION } from './ui.js';

export const MatcherPlugin = {
    id: 'matcher',
    name: 'Semantic Matcher',
    dependencies: ['ontology', 'properties'], // LLM is optional, checked dynamically

    _coreAPI: null,
    ontologyService: null,
    llmService: null, // May be null if LLMPlugin not active/configured
    propertiesPluginAPI: null, // To get properties, though reading state directly is fine

    // --- Plugin Lifecycle ---

    init(coreAPI) {
        this._coreAPI = coreAPI;
        this.ontologyService = coreAPI.getService('OntologyService');
        this.propertiesPluginAPI = coreAPI.getPluginAPI('properties'); // May be null if properties not active
        try {
            this.llmService = coreAPI.getService('LLMService'); // Attempt to get LLM service
        } catch (e) {
            console.warn("MatcherPlugin: LLMService not available.", e.message);
            this.llmService = null;
        }
        console.log(`MatcherPlugin: Initialized. LLM Service available: ${!!this.llmService}`);
    },

    // --- Added for Enhancement #5 ---
    getSettingsOntology() {
        return {
            'propWeight': {
                type: 'number', label: 'Property Match Weight', order: 1,
                min: 0, max: 1, step: 0.05, default: 0.7,
                description: 'Importance of property similarity (0 to 1). Total weight with Vector should ideally be 1.'
            },
            'vectorWeight': {
                type: 'number', label: 'Vector Match Weight', order: 2,
                min: 0, max: 1, step: 0.05, default: 0.3,
                description: 'Importance of text embedding similarity (0 to 1). Requires LLM plugin.'
            },
            'scoreThreshold': {
                type: 'number', label: 'Display Score Threshold', order: 3,
                min: 0, max: 1, step: 0.05, default: 0.3,
                description: 'Minimum combined score (0 to 1) required to display a related note.'
            },
            'topN': {
                type: 'number', label: 'Max Related Notes', order: 4,
                min: 1, max: 20, step: 1, default: 5,
                description: 'Maximum number of related notes to display.'
            }
        };
    },
    // --- End Enhancement #5 ---


    providesServices() {
        // Expose the main MatcherService
        return {
            'MatcherService': {
                /**
                 * Calculates the semantic compatibility between two notes.
                 * Combines property matching and (optional) vector similarity.
                 * @param {object} noteA - The first note object.
                 * @param {object} noteB - The second note object.
                 * @returns {Promise<object>} A promise resolving to { score: number (0-1), explanation: string }.
                 */
                calculateCompatibility: async (noteA, noteB) => {
                    if (!noteA || !noteB) {
                        console.warn("MatcherService: calculateCompatibility called with null notes.");
                        return {score: 0, explanation: "Invalid input notes."};
                    }
                    if (!this.ontologyService) {
                        console.warn("MatcherService: OntologyService not available.");
                        return {score: 0, explanation: "Ontology service unavailable."};
                    }

                    // Use propertiesPluginAPI if available, otherwise access state directly (more robust)
                    const propsA = this._coreAPI.getState().notes[noteA.id]?.pluginData?.properties?.properties || [];
                    const propsB = this._coreAPI.getState().notes[noteB.id]?.pluginData?.properties?.properties || [];


                    // --- 1. Calculate Property Score ---
                    const propScoreResult = this._calculatePropertyScore(propsA, propsB);

                    // --- 2. Calculate Vector Score ---
                    let vectorScoreResult = {
                        score: 0,
                        explanation: "Vector matching disabled (LLM service unavailable)."
                    };
                    let vectorAvailable = false;
                    if (this.llmService) {
                        try {
                            this._coreAPI.showGlobalStatus(`Matcher: Calculating vector similarity for ${noteA.name} & ${noteB.name}...`, "info", 2000);
                            vectorScoreResult = await this._calculateVectorScore(noteA, noteB);
                            // Check if score is valid and embeddings were generated
                            if (typeof vectorScoreResult.score === 'number' && !isNaN(vectorScoreResult.score) && vectorScoreResult.score > 0 && !vectorScoreResult.explanation.includes("Failed") && !vectorScoreResult.explanation.includes("unavailable")) {
                                vectorAvailable = true;
                                this._coreAPI.showGlobalStatus(`Matcher: Vector similarity calculated.`, "success", 1500);
                            } else {
                                // Keep score 0, refine explanation if needed
                                if (!vectorScoreResult.explanation.includes("Failed") && !vectorScoreResult.explanation.includes("unavailable")) {
                                    vectorScoreResult.explanation = "Vector score calculation failed or resulted in zero similarity.";
                                }
                            }
                        } catch (error) {
                            console.error("MatcherPlugin: Error calculating vector score", error);
                            vectorScoreResult = {score: 0, explanation: `Vector matching error: ${error.message}`};
                            this._coreAPI.showGlobalStatus(`Matcher: Vector similarity error.`, "error", 3000);
                        }
                    }

                    // --- 3. Combine Scores ---
                    const settings = this._coreAPI.getPluginSettings(this.id);
                    const defaultOntology = this.getSettingsOntology(); // Get defaults defined in the plugin
                    const propWeight = settings?.propWeight ?? defaultOntology.propWeight.default ?? 0.7;
                    const vectorWeight = settings?.vectorWeight ?? defaultOntology.vectorWeight.default ?? 0.3; // Keep vector weight for future use

                    let finalScore = 0;
                    let explanation = "";

                    // For Phase 3, prioritize property score. If vector is available, use weights, otherwise property score is 100%.
                    let effectivePropWeight = propWeight;
                    let effectiveVectorWeight = vectorAvailable ? vectorWeight : 0;

                    // Normalize weights so they sum to 1 (or propWeight is 1 if vector is unavailable/zero)
                    const totalWeight = effectivePropWeight + effectiveVectorWeight;
                    if (totalWeight > 0) {
                        effectivePropWeight = effectivePropWeight / totalWeight;
                        effectiveVectorWeight = effectiveVectorWeight / totalWeight;
                    } else {
                        // If both weights are 0, default to property score only
                        effectivePropWeight = 1;
                        effectiveVectorWeight = 0;
                    }

                    // Calculate final score using normalized effective weights
                    finalScore = (propScoreResult.score * effectivePropWeight) + (vectorScoreResult.score * effectiveVectorWeight);

                    // Build explanation string
                    explanation = `Property Match (${(effectivePropWeight * 100).toFixed(0)}%): ${propScoreResult.explanation}`;
                    if (vectorAvailable && effectiveVectorWeight > 0) {
                        explanation += `\nVector Match (${(effectiveVectorWeight * 100).toFixed(0)}%): ${vectorScoreResult.explanation}`;
                    } else {
                        // Include reason if vector wasn't used
                        explanation += `\nVector Match: ${vectorScoreResult.explanation}`;
                    }


                    // Clamp score between 0 and 1
                    finalScore = Math.max(0, Math.min(1, finalScore));

                    return {score: finalScore, explanation};
                },
            }
        };
    },

    registerReducer() {
        const pluginId = this.id;
        // Reducer handles embedding cache AND related notes UI state AND embedding status
        return (draft, action) => {
            // Initialize state structure if it doesn't exist
            if (!draft.pluginRuntimeState[pluginId]) {
                draft.pluginRuntimeState[pluginId] = {
                    relatedNotes: {}, // { [noteId]: { isLoading: boolean, matches: MatchResult[], error: string|null } }
                    embeddingStatus: {} // { [noteId]: 'idle' | 'pending' | 'generated' | 'failed' }
                };
            }
            const matcherState = draft.pluginRuntimeState[pluginId];

            switch (action.type) {
                // --- Related Notes UI State ---
                case 'MATCHER_FIND_RELATED_START': {
                    const {noteId} = action.payload;
                    if (!matcherState.relatedNotes[noteId]) matcherState.relatedNotes[noteId] = {};
                    matcherState.relatedNotes[noteId].isLoading = true;
                    matcherState.relatedNotes[noteId].matches = []; // Clear previous matches
                    matcherState.relatedNotes[noteId].error = null;
                    break;
                }
                case 'MATCHER_FIND_RELATED_SUCCESS': {
                    const {noteId, matches} = action.payload;
                    if (!matcherState.relatedNotes[noteId]) matcherState.relatedNotes[noteId] = {};
                    matcherState.relatedNotes[noteId].isLoading = false;
                    matcherState.relatedNotes[noteId].matches = matches;
                    matcherState.relatedNotes[noteId].error = null;
                    break;
                }
                case 'MATCHER_FIND_RELATED_FAILURE': {
                    const {noteId, error} = action.payload;
                    if (!matcherState.relatedNotes[noteId]) matcherState.relatedNotes[noteId] = {};
                    matcherState.relatedNotes[noteId].isLoading = false;
                    matcherState.relatedNotes[noteId].error = error;
                    break;
                }
                case 'CORE_SELECT_NOTE': {
                    // Optionally clear results for the previously selected note to save memory?
                    // const previousNoteId = draft.uiState.selectedNoteId; // This is tricky, state might already be updated
                    // if (previousNoteId && matcherState.relatedNotes[previousNoteId]) {
                    //     delete matcherState.relatedNotes[previousNoteId];
                    // }
                    break;
                }
                case 'CORE_DELETE_NOTE': { // Also clear related notes state for deleted note
                    const {noteId} = action.payload;
                    if (matcherState.relatedNotes[noteId]) {
                        delete matcherState.relatedNotes[noteId];
                    }
                    break;
                }

                // --- Embedding Status State ---
                case 'MATCHER_EMBEDDING_START': {
                    const {noteId} = action.payload;
                    matcherState.embeddingStatus[noteId] = 'pending';
                    break;
                }
                case 'MATCHER_EMBEDDING_SUCCESS': {
                    const {noteId} = action.payload;
                    matcherState.embeddingStatus[noteId] = 'generated';
                    break;
                }
                case 'MATCHER_EMBEDDING_FAILURE': {
                    const {noteId} = action.payload;
                    matcherState.embeddingStatus[noteId] = 'failed';
                    break;
                }

                // --- Embedding Cache State (Handled via CORE_DELETE_NOTE and CORE_SET_RUNTIME_CACHE) ---
                // On update, the cache key using `updatedAt` will naturally become stale.
                // No explicit invalidation needed here if _getOrGenerateEmbedding checks timestamp.
                // case 'CORE_UPDATE_NOTE': { ... break; }

                case 'CORE_DELETE_NOTE': {
                    const {noteId} = action.payload;
                    // Find and remove cache keys associated with this noteId.
                    const cacheKeysToDelete = Object.keys(draft.runtimeCache)
                        .filter(key => key.startsWith(`matcher_embedding_${noteId}_`));

                    if (cacheKeysToDelete.length > 0) {
                        cacheKeysToDelete.forEach(key => {
                            delete draft.runtimeCache[key]; // Immer handles mutation
                        });
                    }
                    break;
                }
                // Action to manually clear all matcher embeddings
                case 'MATCHER_CLEAR_ALL_EMBEDDINGS': {
                    const cacheKeysToDelete = Object.keys(draft.runtimeCache)
                        .filter(key => key.startsWith(`matcher_embedding_`));
                    if (cacheKeysToDelete.length > 0) {
                        console.log(`MatcherPlugin Reducer: Clearing ${cacheKeysToDelete.length} embedding cache entries.`);
                        cacheKeysToDelete.forEach(key => {
                            delete draft.runtimeCache[key];
                        });
                    }
                    break;
                }
            }
            // No return needed when mutating draft
        };
    },

    // --- Middleware for Triggering Background Matching ---
    registerMiddleware() {
        const pluginInstance = this; // Capture 'this'

        // --- Debounced Background Embedding Trigger ---
        const debouncedTriggerEmbedding = Utils.debounce(async (noteId, state, dispatch) => {
            const note = state.notes[noteId];
            if (!note || note.isArchived || !pluginInstance.llmService) return; // Need LLM service

            // Check if embedding is already up-to-date or pending
            const currentStatus = state.pluginRuntimeState?.[pluginInstance.id]?.embeddingStatus?.[noteId];
            const cacheKey = `matcher_embedding_${note.id}_${note.updatedAt}`;
            const cachedEmbedding = state.runtimeCache[cacheKey];

            if (cachedEmbedding || currentStatus === 'pending') {
                return;
            }

            console.log(`Matcher Middleware: Triggering background embedding generation for ${noteId}`);
            // Dispatch start action immediately
            dispatch({type: 'MATCHER_EMBEDDING_START', payload: {noteId}});
            // Call the generation function (it handles success/failure dispatches internally)
            try {
                await pluginInstance._getOrGenerateEmbedding(note);
                // Success/Failure actions are dispatched within _getOrGenerateEmbedding
            } catch (error) {
                // Error already logged and failure dispatched by _getOrGenerateEmbedding
                console.error(`Matcher Middleware: Background embedding failed for ${noteId}`, error);
            }
        }, 2000); // Longer debounce for background task (e.g., 2 seconds after last edit)


        // --- Debounced Related Notes Matching Trigger ---
        const debouncedTriggerMatching = Utils.debounce(async (noteId, state, dispatch) => {
            if (!noteId) return;
            const targetNote = state.notes[noteId];
            if (!targetNote || targetNote.isArchived) return; // Don't match for non-existent or archived notes

            console.log(`Matcher Middleware: Triggering related notes search for ${noteId}`);
            dispatch({type: 'MATCHER_FIND_RELATED_START', payload: {noteId}});

            try {
                const matcherService = pluginInstance._coreAPI.getService('MatcherService');
                if (!matcherService) throw new Error("MatcherService not available.");

                const allOtherNotes = state.noteOrder
                    .map(id => state.notes[id])
                    .filter(note => note && note.id !== noteId && !note.isArchived); // Exclude self and archived

                const similarityPromises = allOtherNotes.map(async otherNote => {
                    try {
                        const result = await matcherService.calculateCompatibility(targetNote, otherNote);
                        return {note: otherNote, score: result.score, explanation: result.explanation};
                    } catch (error) {
                        console.error(`Matcher Middleware: Error comparing ${noteId} with ${otherNote.id}`, error);
                        return null; // Ignore errors for individual comparisons
                    }
                });

                const results = (await Promise.all(similarityPromises)).filter(r => r !== null);

                // Filter, sort, and limit results using configured settings
                const settings = pluginInstance._coreAPI.getPluginSettings(pluginInstance.id);
                const defaultOntology = pluginInstance.getSettingsOntology(); // Get defaults defined in the plugin
                const topN = settings?.topN ?? defaultOntology.topN.default ?? 5;
                const scoreThreshold = settings?.scoreThreshold ?? defaultOntology.scoreThreshold.default ?? 0.3;

                const topMatches = results
                    .filter(r => r.score >= scoreThreshold) // Apply threshold
                    .sort((a, b) => b.score - a.score)     // Sort descending by score
                    .slice(0, topN);                       // Limit to top N

                dispatch({type: 'MATCHER_FIND_RELATED_SUCCESS', payload: {noteId, matches: topMatches}});

            } catch (error) {
                console.error(`Matcher Middleware: Failed to find related notes for ${noteId}`, error);
                dispatch({type: 'MATCHER_FIND_RELATED_FAILURE', payload: {noteId, error: error.message}});
            }
        }, 1000); // Debounce time (e.g., 1 second after selection or update)


        return storeApi => next => action => {
            const result = next(action); // Pass action along first
            const state = storeApi.getState(); // Get state *after* action is processed

            // Trigger on note selection
            if (action.type === 'CORE_SELECT_NOTE') {
                const selectedNoteId = action.payload.noteId;
                debouncedTriggerMatching.cancel(); // Cancel any pending match from previous selection/edit
                if (selectedNoteId) {
                    // Trigger immediately or with short delay? Let's use the debounce.
                    debouncedTriggerMatching(selectedNoteId, state, storeApi.dispatch);
                }
            }

            // Trigger on note content/property update (debounced)
            // Check if the updated note is the currently selected one
            if ((action.type === 'CORE_UPDATE_NOTE' || action.type === 'PROPERTY_ADD' || action.type === 'PROPERTY_UPDATE' || action.type === 'PROPERTY_DELETE') && action.payload.noteId === state.uiState.selectedNoteId) {
                const noteId = action.payload.noteId;
                // Only trigger if content or properties actually changed
                if (action.type === 'CORE_UPDATE_NOTE' && !action.payload.changes?.content) {
                    // If only name changed, maybe don't re-trigger? For now, let it re-trigger matching.
                }
                debouncedTriggerMatching(noteId, state, storeApi.dispatch);

                // Also trigger background embedding if content changed
                if (action.type === 'CORE_UPDATE_NOTE' && action.payload.changes?.content) {
                    debouncedTriggerEmbedding(noteId, state, storeApi.dispatch);
                }
            }

            // Trigger background embedding for newly added notes
            if (action.type === 'CORE_ADD_NOTE') {
                const newNoteId = state.noteOrder[0]; // Assuming core adds to the start
                if (newNoteId) {
                    debouncedTriggerEmbedding(newNoteId, state, storeApi.dispatch);
                }
            }


            return result;
        };
    },


    // --- UI Rendering ---
    registerUISlots() {
        const pluginId = this.id;
        const coreAPI = this._coreAPI; // Capture coreAPI
        const pluginInstance = this; // Capture plugin instance for handlers

        // --- Debounced Save Handler --- (Similar to LLMPlugin)
        const debouncedSaveFunctions = {};
        const createDebouncedSaver = (key, schema, currentProperties, settingsNoteId, dispatch) => {
            if (!debouncedSaveFunctions[key]) {
                debouncedSaveFunctions[key] = coreAPI.utils.debounce((value) => {
                    // console.log(`MatcherPlugin: Saving setting ${key} =`, value);
                    const existingProp = currentProperties.find(p => p.key === key);
                    let actionType = 'PROPERTY_ADD';
                    let payload = {
                        noteId: settingsNoteId,
                        propertyData: {key: key, value: value, type: schema.type || 'text'}
                    };

                    if (existingProp) {
                        if (existingProp.value !== value) {
                            actionType = 'PROPERTY_UPDATE';
                            payload = {
                                noteId: settingsNoteId,
                                propertyId: existingProp.id,
                                changes: {value: value}
                            };
                            dispatch({type: actionType, payload: payload});
                        } else {

                        } // No change
                    } else {
                        dispatch({type: actionType, payload: payload});
                    }
                    // TODO: Add UI save status feedback?
                }, 750);
            }
            return debouncedSaveFunctions[key];
        };


        return {
            // --- Related Notes Panel ---
            [SLOT_EDITOR_PLUGIN_PANELS]: (props) => {
                const {state, dispatch, noteId, html} = props;
                if (!noteId) return ''; // No note selected

                const matcherState = state.pluginRuntimeState?.[pluginId]?.relatedNotes?.[noteId];
                const {isLoading = false, matches = [], error = null} = matcherState || {};

                const handleNoteClick = (relatedNoteId) => {
                    dispatch({type: 'CORE_SELECT_NOTE', payload: {noteId: relatedNoteId}});
                };

                let content;
                if (isLoading) {
                    content = html`<div class="loading-indicator">Finding related notes...</div>`;
                } else if (error) {
                    content = html`<div class="error-message">Error: ${error}</div>`;
                } else if (matches.length === 0) {
                    content = html`<p class="no-matches-message">No related notes found.</p>`;
                } else {
                    content = html`
                        <ul class="related-notes-list">
                            ${matches.map(match => html`
                                <li class="related-note-item" title="Score: ${match.score.toFixed(3)}\n${match.explanation}">
                                    <button class="related-note-link" @click=${() => handleNoteClick(match.note.id)}>
                                        ${match.note.name || 'Untitled Note'}
                                    </button>
                                    <span class="related-note-score">(${(match.score * 100).toFixed(0)}%)</span>
                                </li>
                            `)}
                        </ul>
                    `;
                }

                // Use <details> for collapsibility
                return html`
                    <details class="matcher-related-notes-panel plugin-panel" open>
                        <summary class="plugin-panel-title">Related Notes</summary>
                        <div class="plugin-panel-content">
                            ${content}
                        </div>
                    </details>
                    <!-- Embedding Status Indicator (Keep for later phases) -->
                    ${pluginInstance.llmService ? pluginInstance._renderEmbeddingStatus(state, noteId, html) : ''}
                    <style>
                        .matcher-related-notes-panel summary { cursor: pointer; font-weight: bold; }
                        .matcher-related-notes-panel .plugin-panel-content { padding-top: 5px; }
                        .related-notes-list { list-style: none; padding: 0; margin: 0; }
                        .related-note-item {
                            padding: 4px 0;
                            border-bottom: 1px solid var(--border-color);
                            display: flex;
                            justify-content: space-between;
                            align-items: center;
                        }
                        .related-note-item:last-child { border-bottom: none; }
                        .related-note-link {
                            background: none; border: none; padding: 0; margin: 0;
                            color: var(--link-color); text-decoration: none; cursor: pointer;
                            text-align: left;
                        }
                        .related-note-link:hover { text-decoration: underline; }
                        .related-note-score {
                            font-size: 0.85em; color: var(--secondary-text-color);
                            margin-left: 8px; white-space: nowrap;
                         }
                        .loading-indicator, .error-message, .no-matches-message {
                            padding: 8px; color: var(--secondary-text-color); font-style: italic;
                        }
                        .error-message { color: var(--danger-color); }
                        .embedding-status-indicator {
                            font-size: 0.8em;
                            padding: 2px 6px;
                            margin-top: 5px;
                            border-radius: 3px;
                            display: inline-block;
                            opacity: 0.7;
                        }
                        .embedding-status-indicator.pending { background-color: var(--vscode-editorWarning-foreground); color: var(--vscode-editorWarning-background); }
                        .embedding-status-indicator.generated { background-color: var(--vscode-editorInfo-foreground); color: var(--vscode-editorInfo-background); }
                        .embedding-status-indicator.failed { background-color: var(--vscode-editorError-foreground); color: var(--vscode-editorError-background); }
                        .embedding-status-indicator.idle { background-color: var(--vscode-disabledForeground); color: var(--vscode-editor-background); }
                    </style>
                `;
            },

            // --- Settings Panel Section ---
            [SLOT_SETTINGS_PANEL_SECTION]: (props) => {
                const {state, dispatch, html} = props;
                const settingsOntology = pluginInstance.getSettingsOntology();
                const settingsNote = coreAPI.getSystemNoteByType(`config/settings/${pluginId}`);
                const propsApi = coreAPI.getPluginAPI('properties');
                const currentProperties = settingsNote ? (propsApi?.getPropertiesForNote(settingsNote.id) || []) : [];

                // Convert current properties to a simple { key: value } map
                const currentValues = {};
                currentProperties.forEach(p => {
                    currentValues[p.key] = p.value;
                });

                // Get defaults from ontology definition
                const defaultValues = {};
                Object.keys(settingsOntology).forEach(key => {
                    if (settingsOntology[key].hasOwnProperty('default')) {
                        defaultValues[key] = settingsOntology[key].default;
                    }
                });

                const displayConfig = {...defaultValues, ...currentValues};

                // --- Input Handlers ---
                const handleInput = (key, value) => { // Removed schema parameter
                    createDebouncedSaver(key, settingsOntology[key], currentProperties, settingsNote.id, dispatch)(value); // Schema is now retrieved inside createDebouncedSaver
                };
                const handleNumberInput = (key, value, schema) => {
                    const isFloat = schema.step && String(schema.step).includes('.');
                    const number = isFloat ? parseFloat(value) : parseInt(value, 10);
                    if (!isNaN(number)) {
                        handleInput(key, number); // Schema not passed here either
                    } else if (value === '') {
                        handleInput(key, null); // Schema not passed here either
                    }
                };

                // --- Render Logic ---
                if (!settingsNote) {
                    return html`
                        <div class="settings-section matcher-settings">
                            <h4>${pluginInstance.name}</h4>
                            <p>Settings note not found.</p>
                            <button @click=${() => dispatch({
                        type: 'CORE_ADD_NOTE', payload: {
                            name: `${pluginInstance.name} Settings`,
                            systemType: `config/settings/${pluginId}`,
                            content: `Stores configuration properties for the ${pluginId} plugin.`
                        }
                    })}>Create Settings Note</button>
                        </div>`;
                }

                const sortedKeys = Object.keys(settingsOntology).sort((a, b) => (settingsOntology[a].order || 99) - (settingsOntology[b].order || 99));

                return html`
                    <div class="settings-section matcher-settings">
                        <h4>${pluginInstance.name}</h4>
                        <p class="settings-description">Configure matching behavior. Autosaves on change.</p>
                        ${sortedKeys.map(key => {
                    const schema = settingsOntology[key];
                    const currentValue = displayConfig[key];
                    const inputId = `matcher-setting-${key}`;
                    let inputElement;

                    if (schema.type === 'number') {
                        const isFloat = schema.step && String(schema.step).includes('.');
                        inputElement = html`<input type="number" id=${inputId} .value=${currentValue ?? ''}
                                                           min=${schema.min ?? ''} max=${schema.max ?? ''} step=${schema.step ?? ''}
                                                           @input=${(e) => handleNumberInput(key, e.target.value, schema)}>`;
                    } else { // Default text (add more types if needed)
                        inputElement = html`<input type="text" id=${inputId} .value=${currentValue ?? ''}
                                                           placeholder=${schema.placeholder || ''}
                                                           @input=${(e) => handleInput(key, e.target.value)}>`; // Schema not passed here
                    }

                    return html`
                                <div class="setting-item">
                                    <label for=${inputId}>${schema.label || key}</label>
                                    ${inputElement}
                                    ${schema.description ? html`<span class="field-hint">${schema.description}</span>` : ''}
                                </div>`;
                })}
                        <!-- Button to clear cache -->
                        <div class="setting-item">
                            <label>Embedding Cache:</label>
                            <button @click=${() => dispatch({type: 'MATCHER_CLEAR_ALL_EMBEDDINGS'})}
                                    title="Clear all cached text embeddings generated by the Matcher plugin. They will be regenerated as needed.">
                                Clear Cache
                            </button>
                            <span class="field-hint">Removes locally stored embeddings to save space or force regeneration. Requires LLM plugin.</span>
                        </div>
                    </div>
                    <style>
                        /* Add some basic styling for the settings form */
                        .matcher-settings .settings-description {
                            font-size: 0.9em;
                            color: var(--secondary-text-color);
                            margin-bottom: 1em;
                        }
                        .matcher-settings .setting-item {
                            margin-bottom: 1em;
                            display: flex;
                            flex-direction: column; /* Stack label, input, hint */
                        }
                        .matcher-settings .setting-item label {
                            margin-bottom: 0.3em;
                            font-weight: bold;
                        }
                        .matcher-settings .setting-item input[type="number"],
                        .matcher-settings .setting-item input[type="text"] {
                            padding: 4px 6px;
                            border: 1px solid var(--input-border-color, #ccc);
                            border-radius: 3px;
                            background-color: var(--input-background-color, #fff);
                            color: var(--input-text-color, #333);
                            max-width: 150px; /* Limit width of inputs */
                        }
                        .matcher-settings .setting-item .field-hint {
                            font-size: 0.85em;
                            color: var(--secondary-text-color);
                            margin-top: 0.4em;
                        }
                         .matcher-settings .setting-item button {
                            padding: 4px 8px;
                            cursor: pointer;
                            align-self: flex-start; /* Align button left */
                         }
                    </style>
                `;
            }
        };
    },

    // --- UI Helper for Embedding Status (Keep for later phases) ---
    _renderEmbeddingStatus(state, noteId, html) {
        const status = state.pluginRuntimeState?.[this.id]?.embeddingStatus?.[noteId] || 'idle';
        let text = 'Embeddings: ';
        let title = '';
        switch (status) {
            case 'pending':
                text += 'Generating...';
                title = 'AI is processing this note for semantic search.';
                break;
            case 'generated':
                text += 'Ready';
                title = 'Semantic embeddings are up-to-date.';
                break;
            case 'failed':
                text += 'Failed';
                title = 'Could not generate semantic embeddings for this note. Check LLM settings/logs.';
                break;
            case 'idle':
            default:
                text += 'Not generated';
                title = 'Embeddings will be generated when needed or on update.';
                break;
        }
        return html`<span class="embedding-status-indicator ${status}" title=${title}>${text}</span>`;
    },

    // --- Internal Score Calculation Methods ---

    /**
     * Calculates compatibility score based on shared/similar properties.
     * @param {Array} propsA - Properties array for note A.
     * @param {Array} propsB - Properties array for note B.
     * @returns {object} { score: number (0-1), explanation: string }
     */
    _calculatePropertyScore(propsA = [], propsB = []) {
        if (!this.ontologyService) return {score: 0, explanation: "Ontology service unavailable."};
        if (!Array.isArray(propsA)) propsA = []; // Ensure arrays
        if (!Array.isArray(propsB)) propsB = [];

        if (propsA.length === 0 && propsB.length === 0) return {score: 0, explanation: "No properties on either note."};

        const mapA = new Map(propsA.map(p => [p.key?.toLowerCase(), p])); // Use lowercase keys for matching
        const mapB = new Map(propsB.map(p => [p.key?.toLowerCase(), p]));
        const allKeys = new Set([...mapA.keys(), ...mapB.keys()]);

        let totalScore = 0;
        let matchingPropertiesCount = 0;
        const explanations = [];

        for (const key of allKeys) {
            const propA = mapA.get(key);
            const propB = mapB.get(key);

            if (propA && propB) {
                // Key exists in both, compare values
                const valueA = propA.value;
                const valueB = propB.value;
                // Use the type stored on the property if available, otherwise infer
                const typeA = propA.type || this.ontologyService.inferType(valueA, key);
                const typeB = propB.type || this.ontologyService.inferType(valueB, key);

                let matchScore = 0;
                let comparisonType = 'Mismatch';

                if (typeA === typeB) {
                    comparisonType = typeA; // Use the matched type for comparison logic
                    switch (typeA) {
                        case 'date':
                            matchScore = this._compareDates(valueA, valueB);
                            break;
                        case 'number':
                            // Ensure both are treated as numbers for comparison
                            const numA = Number(valueA);
                            const numB = Number(valueB);
                            if (!isNaN(numA) && !isNaN(numB)) {
                                const diff = Math.abs(numA - numB);
                                // Use a dynamic range based on the values themselves, or a fixed range?
                                // Let's use a simple approach: 1 for exact match, decreasing score based on difference.
                                // Max difference considered "relevant" could be context-dependent.
                                // For priority (1-10), a diff of 1 is significant. For counts, less so.
                                // Simple linear decay: score = max(0, 1 - diff / scale)
                                // Let's use a scale of 10 for general numbers for now.
                                const scale = 10;
                                matchScore = Math.max(0, 1 - (diff / scale));
                                if (diff > 0) matchScore *= 0.9; // Penalize non-exact matches slightly
                            } else {
                                // If conversion failed, fallback to string comparison
                                matchScore = (String(valueA) === String(valueB)) ? 0.5 : 0;
                            }
                            break;
                        case 'boolean':
                            // Normalize boolean representation before comparing
                            const boolA = ['true', 'yes', '1', 'on'].includes(String(valueA).toLowerCase());
                            const boolB = ['true', 'yes', '1', 'on'].includes(String(valueB).toLowerCase());
                            matchScore = (boolA === boolB) ? 1.0 : 0;
                            break;
                        case 'list':
                            matchScore = this._compareLists(valueA, valueB);
                            break;
                        case 'reference':
                            // High score for exact match (case-insensitive) of reference values (e.g., note names/IDs)
                            if (typeof valueA === 'string' && typeof valueB === 'string' && valueA.trim().toLowerCase() === valueB.trim().toLowerCase()) {
                                matchScore = 0.95; // High score for direct reference match
                            } else {
                                matchScore = 0; // No match if references differ
                            }
                            // TODO: Future: Resolve references to actual note IDs and compare IDs
                            break;
                        case 'url':
                            // Normalize URLs before comparing? (e.g., remove trailing slash, http vs https?) Basic for now.
                            matchScore = (String(valueA).trim() === String(valueB).trim()) ? 1.0 : 0.5; // Lower score for non-exact?
                            break;
                        case 'location': // Basic string match for now
                        case 'text':
                        default: // Default to string comparison
                            const strA = String(valueA).trim();
                            const strB = String(valueB).trim();
                            if (strA.toLowerCase() === strB.toLowerCase()) {
                                matchScore = 1.0;
                            } else {
                                // Use Jaccard index for partial text match
                                const wordsA = new Set(strA.toLowerCase().split(/\s+/).filter(w => w.length > 1)); // Min word length 2
                                const wordsB = new Set(strB.toLowerCase().split(/\s+/).filter(w => w.length > 1));
                                if (wordsA.size > 0 || wordsB.size > 0) {
                                    matchScore = this._jaccardIndex(wordsA, wordsB) * 0.7; // Penalize non-exact text
                                } else {
                                    matchScore = 0; // No meaningful words
                                }
                            }
                            break;
                    }
                } else {
                    // Type mismatch - potential for future cross-type comparison (e.g., string "10" vs number 10)
                    // For now, consider it no match.
                    matchScore = 0;
                    comparisonType = `Mismatch (${typeA} vs ${typeB})`;
                }

                // Apply weighting based on property type? (e.g., matching 'status' might be more important than 'url')
                // For now, all matches contribute equally.

                if (matchScore > 0.1) { // Use a slightly higher threshold to count as matching
                    totalScore += matchScore;
                    matchingPropertiesCount++;
                    // Use original key casing for explanation for readability
                    const displayKey = propA.key || key;
                    explanations.push(`'${displayKey}' (${comparisonType}): ${matchScore.toFixed(2)}`);
                }
            }
            // If key exists only in one note, it doesn't contribute to the score.
        }

        // Normalize score: Average score over the number of properties that *matched*?
        // Or normalize by the total number of unique properties across both notes?
        // Normalizing by total unique properties (`allKeys.size`) gives a sense of overall similarity.
        // Normalizing by `matchingPropertiesCount` emphasizes the strength of the matches found.
        // Let's normalize by `allKeys.size` to represent the proportion of shared/similar properties.
        const normalizationFactor = allKeys.size > 0 ? allKeys.size : 1;
        let finalScore = normalizationFactor > 0 ? totalScore / normalizationFactor : 0;

        // Boost score slightly based on the *number* of matching properties?
        // Example: Add a small bonus proportional to matchingPropertiesCount / allKeys.size
        if (allKeys.size > 0 && matchingPropertiesCount > 0) {
            const matchRatioBonus = (matchingPropertiesCount / allKeys.size) * 0.1; // Small bonus (max 0.1)
            finalScore = Math.min(1, finalScore + matchRatioBonus);
        }


        const explanation = matchingPropertiesCount > 0
            ? `${matchingPropertiesCount} matching properties (${explanations.join(', ')}). Avg score: ${finalScore.toFixed(3)}`
            : "No matching property keys found.";

        // Ensure score is clamped between 0 and 1
        finalScore = Math.max(0, Math.min(1, finalScore));

        return {score: finalScore, explanation};
    },

    /**
     * Calculates compatibility score based on text embedding similarity.
     * Handles embedding generation, caching, and cosine similarity calculation.
     * @param {object} noteA - The first note object.
     * @param {object} noteB - The second note object.
     * @returns {Promise<object>} A promise resolving to { score: number (0-1), explanation: string }.
     */
    async _calculateVectorScore(noteA, noteB) {
        // Check if LLM service is available AND configured with a model (needed for embeddings)
        const llmConfig = this.llmService ? this._coreAPI.getService('LLMService')?.getCurrentConfig() : null;
        const embeddingsPossible = !!(this.llmService && llmConfig?.modelName); // Assume embeddings need a model

        if (!embeddingsPossible) {
            return {
                score: 0,
                explanation: "Vector matching disabled (LLM service/model unavailable or not configured)."
            };
        }

        try {
            // Get embeddings concurrently
            const [embeddingA, embeddingB] = await Promise.all([
                this._getOrGenerateEmbedding(noteA),
                this._getOrGenerateEmbedding(noteB)
            ]);

            // Check if both embeddings were successfully generated
            if (!embeddingA || !embeddingB) {
                let reason = "";
                if (!embeddingA && !embeddingB) reason = "both notes";
                else if (!embeddingA) reason = `note "${noteA.name || noteA.id}"`;
                else reason = `note "${noteB.name || noteB.id}"`;
                return {
                    score: 0,
                    explanation: `Vector match failed: Could not generate embeddings for ${reason}.`
                };
            }

            // Calculate similarity
            const similarity = this._cosineSimilarity(embeddingA, embeddingB);

            if (isNaN(similarity)) {
                console.warn("MatcherPlugin: Cosine similarity calculation resulted in NaN.");
                return {score: 0, explanation: "Vector match failed: Similarity calculation error."};
            }

            // Return clamped score and explanation
            return {
                score: Math.max(0, Math.min(1, similarity)), // Clamp score between 0 and 1
                explanation: `Cosine similarity: ${similarity.toFixed(3)}`
            };

        } catch (error) {
            // Catch errors from embedding generation or similarity calculation
            console.error("MatcherPlugin: _calculateVectorScore error", error);
            // Check if the error message indicates a configuration issue already handled by LLMService
            const isConfigError = error.message.includes("LLM Config Error") || error.message.includes("Model Name is required");
            const explanation = isConfigError
                ? `Vector match failed: ${error.message}` // Use specific config error
                : `Vector match error: ${error.message}`; // Generic error
            return {score: 0, explanation: explanation};
        }
    },

    /**
     * Retrieves cached embedding or generates a new one via LLMService.
     * Caches the result in runtimeCache.
     * @param {object} note - The note object.
     * @returns {Promise<Array<number>|null>} The embedding vector or null on failure.
     */
    async _getOrGenerateEmbedding(note) {
        // Check if LLM service is available AND configured (as embeddings might need specific models/keys)
        const llmConfig = this.llmService ? this._coreAPI.getService('LLMService')?.getCurrentConfig() : null;
        const embeddingsPossible = !!(this.llmService && llmConfig?.modelName); // Basic check, assumes main model implies embedding capability

        if (!embeddingsPossible) {
            // console.warn(`MatcherPlugin: Skipping embedding generation for note ${note.id}, LLM service/model unavailable or not configured.`);
            // Ensure status reflects this if it was pending
            const currentStatus = this._coreAPI.getState().pluginRuntimeState?.[this.id]?.embeddingStatus?.[note.id];
            if (currentStatus === 'pending') {
                this._coreAPI.dispatch({type: 'MATCHER_EMBEDDING_FAILURE', payload: {noteId: note.id}});
            }
            return null;
        }

        // Use updatedAt timestamp in cache key for automatic invalidation on note update
        const cacheKey = `matcher_embedding_${note.id}_${note.updatedAt}`;
        const cachedEmbedding = this._coreAPI.getRuntimeCache(cacheKey);

        if (cachedEmbedding) {
            // Ensure status is 'generated' if we found a cached version
            const currentStatus = this._coreAPI.getState().pluginRuntimeState?.[this.id]?.embeddingStatus?.[note.id];
            if (currentStatus !== 'generated') {
                this._coreAPI.dispatch({type: 'MATCHER_EMBEDDING_SUCCESS', payload: {noteId: note.id}});
            }
            return cachedEmbedding;
        }

        const textToEmbed = `${note.name || ''}\n\n${note.content || ''}`.trim();

        if (!textToEmbed) {
            // console.log(`MatcherPlugin: Note ${note.id} has no content to embed.`);
            this._coreAPI.dispatch({type: 'MATCHER_EMBEDDING_failure', payload: {noteId: note.id}}); // Mark as failed if no content
            return null; // Cannot embed empty text
        }

        // Dispatch START action before async call
        this._coreAPI.dispatch({type: 'MATCHER_EMBEDDING_START', payload: {noteId: note.id}});
        this._coreAPI.showGlobalStatus(`Matcher: Generating embedding for "${note.name || note.id}"...`, "info", 2500); // User feedback

        try {
            // Call the LLM service
            const embeddingVector = await this.llmService.generateEmbeddings(textToEmbed);

            // Validate the result
            if (!embeddingVector || !Array.isArray(embeddingVector) || embeddingVector.length === 0) {
                throw new Error("LLMService returned invalid or empty embedding data.");
            }

            // Dispatch SUCCESS action
            this._coreAPI.dispatch({type: 'MATCHER_EMBEDDING_SUCCESS', payload: {noteId: note.id}});

            // Cache the successful result using CORE_SET_RUNTIME_CACHE action
            this._coreAPI.dispatch({
                type: 'CORE_SET_RUNTIME_CACHE',
                payload: {key: cacheKey, value: embeddingVector}
            });
            // console.log(`MatcherPlugin: Embedding generated and cached for note ${note.id} with key ${cacheKey}`);
            this._coreAPI.showGlobalStatus(`Matcher: Embedding generated for "${note.name || note.id}".`, "success", 1500);

            return embeddingVector;

        } catch (error) {
            // Dispatch FAILURE action
            console.error(`MatcherPlugin: Failed to generate embedding for note ${note.id}`, error);
            this._coreAPI.dispatch({type: 'MATCHER_EMBEDDING_FAILURE', payload: {noteId: note.id}});
            // Show error status (LLMService might have already shown one, but this confirms the embedding context)
            this._coreAPI.showGlobalStatus(`Matcher: Embedding failed for "${note.name || note.id}". Check LLM config/logs.`, "error", 4000);
            return null; // Return null on failure
        }
    },

    /**
     * Calculates the cosine similarity between two vectors.
     * @param {Array<number>} vecA
     * @param {Array<number>} vecB
     * @returns {number} Similarity score (-1 to 1), or 0 if inputs are invalid.
     */
    _cosineSimilarity(vecA, vecB) {
        if (!vecA || !vecB || !Array.isArray(vecA) || !Array.isArray(vecB) || vecA.length !== vecB.length || vecA.length === 0) {
            console.warn("MatcherPlugin: Invalid input for cosineSimilarity", {lenA: vecA?.length, lenB: vecB?.length});
            return 0; // Handle invalid input
        }

        let dotProduct = 0;
        let magA = 0;
        let magB = 0;
        for (let i = 0; i < vecA.length; i++) {
            dotProduct += (vecA[i] || 0) * (vecB[i] || 0); // Ensure numbers
            magA += (vecA[i] || 0) * (vecA[i] || 0);
            magB += (vecB[i] || 0) * (vecB[i] || 0);
        }

        magA = Math.sqrt(magA);
        magB = Math.sqrt(magB);

        if (magA === 0 || magB === 0) {
            // If both vectors are zero vectors, are they similar (1) or dissimilar (0)? Let's say 0.
            return 0;
        }

        const similarity = dotProduct / (magA * magB);
        return isNaN(similarity) ? 0 : similarity; // Handle potential NaN if magnitudes somehow become invalid
    }, // Added comma

    /**
     * Compares two date strings and returns a score based on proximity.
     * @param {string} dateStrA
     * @param {string} dateStrB
     * @returns {number} Score between 0 and 1.
     * @private
     */
    _compareDates(dateStrA, dateStrB) {
        try {
            const dateA = new Date(dateStrA);
            const dateB = new Date(dateStrB);
            if (isNaN(dateA.getTime()) || isNaN(dateB.getTime())) return 0; // Invalid date format

            const diffMillis = Math.abs(dateA.getTime() - dateB.getTime());
            const diffDays = diffMillis / (1000 * 60 * 60 * 24);

            // Score decreases as difference increases. Score is ~1 for same day, ~0.5 for 1 day diff, etc.
            // Adjust the denominator to control how quickly the score drops off.
            const score = 1 / (1 + diffDays);
            return score;
        } catch (e) {
            console.warn("MatcherPlugin: Error comparing dates", dateStrA, dateStrB, e);
            return 0; // Error during parsing/comparison
        }
    }, // Added comma

    /**
     * Compares two lists (arrays or comma-separated strings) using Jaccard index.
     * @param {Array|string} listA
     * @param {Array|string} listB
     * @returns {number} Jaccard index score (0 to 1).
     * @private
     */
    _compareLists(listA, listB) {
        const setA = new Set(Array.isArray(listA) ? listA : String(listA).split(',').map(s => s.trim()).filter(s => s));
        const setB = new Set(Array.isArray(listB) ? listB : String(listB).split(',').map(s => s.trim()).filter(s => s));

        return this._jaccardIndex(setA, setB);
    }, // Added comma

    /**
     * Calculates the Jaccard index (intersection over union) for two sets.
     * @param {Set<any>} setA
     * @param {Set<any>} setB
     * @returns {number} Jaccard index (0 to 1).
     * @private
     */
    _jaccardIndex(setA, setB) {
        if (!(setA instanceof Set) || !(setB instanceof Set)) return 0;
        const intersectionSize = new Set([...setA].filter(x => setB.has(x))).size;
        const unionSize = setA.size + setB.size - intersectionSize;

        return unionSize === 0 ? 1 : intersectionSize / unionSize; // Return 1 if both sets are empty? Or 0? Let's say 1.
    }
};

// Example of how another plugin might use the MatcherService:
/*
const someOtherPlugin = {
    // ... other plugin properties ...
    dependencies: ['matcher'], // Depend on the matcher plugin
    coreAPI: null,
    matcherService: null,

    init(coreAPI) {
        this.coreAPI = coreAPI;
        this.matcherService = coreAPI.getService('MatcherService');
    },

    async findSimilarNotes(targetNote) {
        if (!this.matcherService) {
            console.error("MatcherService not available.");
            return [];
        }

        const state = this.coreAPI.getState();
        const allOtherNotes = state.noteOrder
            .map(id => state.notes[id])
            .filter(note => note && note.id !== targetNote.id && !note.isArchived);

        const similarityResults = [];

        for (const otherNote of allOtherNotes) {
            try {
                const result = await this.matcherService.calculateCompatibility(targetNote, otherNote);
                if (result.score > 0.5) { // Example threshold
                    similarityResults.push({ note: otherNote, score: result.score, explanation: result.explanation });
                }
            } catch (error) {
                console.error(`Error comparing note ${targetNote.id} with ${otherNote.id}`, error);
            }
        }

        // Sort by score descending
        similarityResults.sort((a, b) => b.score - a.score);

        console.log(`Found ${similarityResults.length} notes similar to "${targetNote.name}":`, similarityResults);
        return similarityResults;
    }
}
*/
