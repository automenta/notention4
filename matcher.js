"use strict";

// Purpose: Calculate semantic compatibility score between two notes.
// Combines property-based matching and optional vector-based matching.

export const MatcherPlugin = {
    id: 'matcher',
    name: 'Semantic Matcher',
    dependencies: ['ontology', 'properties'], // LLM is optional, checked dynamically

    coreAPI: null,
    ontologyService: null,
    llmService: null, // May be null if LLMPlugin not active/configured
    propertiesPluginAPI: null, // To get properties, though reading state directly is fine

    // --- Plugin Lifecycle ---

    init(coreAPI) {
        this.coreAPI = coreAPI;
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
                    const propsA = this.coreAPI.getState().notes[noteA.id]?.pluginData?.properties?.properties || [];
                    const propsB = this.coreAPI.getState().notes[noteB.id]?.pluginData?.properties?.properties || [];


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
                            this.coreAPI.showGlobalStatus(`Matcher: Calculating vector similarity for ${noteA.name} & ${noteB.name}...`, "info", 2000);
                            vectorScoreResult = await this._calculateVectorScore(noteA, noteB);
                            // Check if score is valid and embeddings were generated
                            if (typeof vectorScoreResult.score === 'number' && !isNaN(vectorScoreResult.score) && vectorScoreResult.score > 0 && !vectorScoreResult.explanation.includes("Failed") && !vectorScoreResult.explanation.includes("unavailable")) {
                                vectorAvailable = true;
                                this.coreAPI.showGlobalStatus(`Matcher: Vector similarity calculated.`, "success", 1500);
                            } else {
                                // Keep score 0, refine explanation if needed
                                if (!vectorScoreResult.explanation.includes("Failed") && !vectorScoreResult.explanation.includes("unavailable")) {
                                    vectorScoreResult.explanation = "Vector score calculation failed or resulted in zero similarity.";
                                }
                            }
                        } catch (error) {
                            console.error("MatcherPlugin: Error calculating vector score", error);
                            vectorScoreResult = {score: 0, explanation: `Vector matching error: ${error.message}`};
                            this.coreAPI.showGlobalStatus(`Matcher: Vector similarity error.`, "error", 3000);
                        }
                    }

                    // --- 3. Combine Scores ---
                    // TODO: Make weights configurable via settings?
                    const propWeight = 0.7;
                    const vectorWeight = 0.3;
                    let finalScore = 0;
                    let explanation = "";

                    if (vectorAvailable) {
                        finalScore = (propScoreResult.score * propWeight) + (vectorScoreResult.score * vectorWeight);
                        explanation = `Property Match (${(propWeight * 100).toFixed(0)}%): ${propScoreResult.explanation}\nVector Match (${(vectorWeight * 100).toFixed(0)}%): ${vectorScoreResult.explanation}`;
                    } else {
                        // If vector isn't available or failed, property score takes full weight
                        finalScore = propScoreResult.score;
                        explanation = `Property Match (100%): ${propScoreResult.explanation}\nVector Match: ${vectorScoreResult.explanation}`; // Still show why vector failed/disabled
                    }

                    // Clamp score between 0 and 1
                    finalScore = Math.max(0, Math.min(1, finalScore));

                    return {score: finalScore, explanation};
                },
            }
        };
    },

    registerReducer() {
        // Reducer primarily handles invalidating/cleaning the embedding cache in runtimeCache
        return (draft, action) => {
            switch (action.type) {
                // On update, the cache key using `updatedAt` will naturally become stale.
                // No explicit invalidation needed here if _getOrGenerateEmbedding checks timestamp.
                // case 'CORE_UPDATE_NOTE': { ... break; }

                case 'CORE_DELETE_NOTE': {
                    const {noteId} = action.payload;
                    // Find and remove cache keys associated with this noteId.
                    const cacheKeysToDelete = Object.keys(draft.runtimeCache)
                        .filter(key => key.startsWith(`matcher_embedding_${noteId}_`));

                    if (cacheKeysToDelete.length > 0) {
                        // console.log(`MatcherPlugin Reducer: Deleting ${cacheKeysToDelete.length} embedding cache entries for deleted note ${noteId}`);
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
        };
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
        if (propsA.length === 0 && propsB.length === 0) return {score: 0, explanation: "No properties on either note."};

        const mapA = new Map(propsA.map(p => [p.key, p]));
        const mapB = new Map(propsB.map(p => [p.key, p]));
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
                            if (typeof valueA === 'number' && typeof valueB === 'number') {
                                const diff = Math.abs(valueA - valueB);
                                const range = Math.max(Math.abs(valueA), Math.abs(valueB), 1);
                                matchScore = Math.max(0, 1 - (diff / range));
                                matchScore = isNaN(matchScore) ? 0 : matchScore * 0.9; // Slightly penalize non-exact
                            } else { matchScore = (valueA == valueB) ? 0.5 : 0; } // Loose equality check if not numbers
                            break;
                        case 'boolean':
                            matchScore = (valueA === valueB) ? 1.0 : 0;
                            break;
                        case 'list':
                            matchScore = this._compareLists(valueA, valueB);
                            break;
                        case 'reference':
                            // High score for exact match of reference values (note names/IDs)
                            if (typeof valueA === 'string' && typeof valueB === 'string' && valueA.toLowerCase() === valueB.toLowerCase()) {
                                matchScore = 0.95; // High score for direct reference match
                            } else {
                                matchScore = 0; // No match if references differ
                            }
                            // TODO: Future: Resolve references to actual note IDs and compare IDs
                            break;
                        case 'url':
                        case 'location': // Basic string match for now
                        case 'text':
                        default: // Default to string comparison
                            if (valueA === valueB) {
                                matchScore = 1.0;
                            } else if (typeof valueA === 'string' && typeof valueB === 'string') {
                                // Simple Jaccard index for words? Or keep prefix match? Let's try Jaccard.
                                const wordsA = new Set(valueA.toLowerCase().split(/\s+/).filter(w => w.length > 2));
                                const wordsB = new Set(valueB.toLowerCase().split(/\s+/).filter(w => w.length > 2));
                                if (wordsA.size > 0 || wordsB.size > 0) {
                                     matchScore = this._jaccardIndex(wordsA, wordsB) * 0.7; // Penalize non-exact text
                                } else {
                                     matchScore = 0; // No meaningful words
                                }
                            } else { // Different underlying types treated as string
                                matchScore = (String(valueA) === String(valueB)) ? 0.8 : 0; // Penalize type coercion match
                            }
                            break;
                    }
                } else {
                    // Type mismatch - potential for future cross-type comparison (e.g., string "10" vs number 10)
                    matchScore = 0; // Keep score 0 for type mismatches for now
                    comparisonType = `Mismatch (${typeA} vs ${typeB})`;
                }

                if (matchScore > 0.01) { // Use a small threshold to count as matching
                    totalScore += matchScore;
                    matchingPropertiesCount++;
                    explanations.push(`'${key}' (${comparisonType}): ${matchScore.toFixed(2)}`);
                }
            }
        }

        // Normalize score: Average score over all unique properties, or over matching properties?
        // Let's normalize by the total number of unique properties involved.
        const normalizationFactor = allKeys.size > 0 ? allKeys.size : 1;
        const finalScore = totalScore / normalizationFactor;

        const explanation = matchingPropertiesCount > 0
            ? `${matchingPropertiesCount} matching properties (${explanations.join(', ')}). Score: ${finalScore.toFixed(3)}`
            : "No matching property keys found.";

        return {score: Math.max(0, Math.min(1, finalScore)), explanation};
    },

    /**
     * Calculates compatibility score based on text embedding similarity.
     * Handles embedding generation, caching, and cosine similarity calculation.
     * @param {object} noteA - The first note object.
     * @param {object} noteB - The second note object.
     * @returns {Promise<object>} A promise resolving to { score: number (0-1), explanation: string }.
     */
    async _calculateVectorScore(noteA, noteB) {
        if (!this.llmService) { // Should be checked before calling, but double-check
            return {score: 0, explanation: "Vector matching disabled (LLM service unavailable)."};
        }

        try {
            const embeddingA = await this._getOrGenerateEmbedding(noteA);
            const embeddingB = await this._getOrGenerateEmbedding(noteB);

            if (!embeddingA || !embeddingB) {
                return {
                    score: 0,
                    explanation: "Vector match failed: Could not generate embeddings for one or both notes."
                };
            }

            const similarity = this._cosineSimilarity(embeddingA, embeddingB);

            if (isNaN(similarity)) {
                console.warn("MatcherPlugin: Cosine similarity calculation resulted in NaN.");
                return {score: 0, explanation: "Vector match failed: Similarity calculation error."};
            }

            return {
                score: Math.max(0, Math.min(1, similarity)),
                explanation: `Cosine similarity: ${similarity.toFixed(3)}`
            };

        } catch (error) {
            console.error("MatcherPlugin: _calculateVectorScore error", error);
            return {score: 0, explanation: `Vector match error: ${error.message}`};
        }
    },

    /**
     * Retrieves cached embedding or generates a new one via LLMService.
     * Caches the result in runtimeCache.
     * @param {object} note - The note object.
     * @returns {Promise<Array<number>|null>} The embedding vector or null on failure.
     */
    async _getOrGenerateEmbedding(note) {
        if (!this.llmService) return null; // LLM needed

        const cacheKey = `matcher_embedding_${note.id}_${note.updatedAt}`;
        const cachedEmbedding = this.coreAPI.getRuntimeCache(cacheKey);

        if (cachedEmbedding) {
            // console.log(`MatcherPlugin: Using cached embedding for note ${note.id}`);
            return cachedEmbedding;
        }

        // console.log(`MatcherPlugin: Generating embedding for note ${note.id}`);
        const textToEmbed = `${note.name || ''}\n\n${note.content || ''}`.trim();

        if (!textToEmbed) {
            // console.log(`MatcherPlugin: Note ${note.id} has no content to embed.`);
            return null; // Cannot embed empty text
        }

        try {
            this.coreAPI.showGlobalStatus(`Matcher: Generating embedding for "${note.name}"...`, "info", 2500);
            const embeddingVector = await this.llmService.generateEmbeddings(textToEmbed);

            if (!embeddingVector || !Array.isArray(embeddingVector) || embeddingVector.length === 0) {
                throw new Error("LLMService returned invalid embedding data.");
            }

            // Cache the successful result
            this.coreAPI.dispatch({
                type: 'CORE_SET_RUNTIME_CACHE',
                payload: {key: cacheKey, value: embeddingVector}
            });
            this.coreAPI.showGlobalStatus(`Matcher: Embedding generated for "${note.name}".`, "success", 1500);

            return embeddingVector;

        } catch (error) {
            console.error(`MatcherPlugin: Failed to generate embedding for note ${note.id}`, error);
            this.coreAPI.showGlobalStatus(`Matcher: Embedding failed for "${note.name}".`, "error", 4000);
            // Optionally cache the failure for a short time? For now, just return null.
            return null;
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
            // console.log("MatcherPlugin: Zero magnitude vector in cosineSimilarity.");
            // If both vectors are zero vectors, are they similar (1) or dissimilar (0)? Let's say 0.
            return 0;
        }

        const similarity = dotProduct / (magA * magB);
        return isNaN(similarity) ? 0 : similarity; // Handle potential NaN if magnitudes somehow become invalid
    },

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
    },

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
    },

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
