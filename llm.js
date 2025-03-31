// Purpose: Plugin for centralized access to Language Models using Langchain.js (loaded from CDN).

"use strict";

import {SLOT_SETTINGS_PANEL_SECTION} from './ui.js';

// Assuming these are correctly resolved in your environment
import {ChatOpenAI, OpenAIEmbeddings} from "@langchain/openai";
import {AIMessage, HumanMessage, SystemMessage} from "@langchain/core/messages";
import './llm.css';

const {html, css, LitElement} = window.lit ?? window.litHtml; // Use lit if available, else fallback
const render = window.litHtml.render ?? window.lit.render;

export const LLMPlugin = {
    id: 'llm',
    name: 'Language Model Interface (LangChain)',
    version: '1.2.1', // Incremented version
    dependencies: [],

    _config: { // Default/initial config structure
        apiKey: ' ',
        endpointUrl: 'http://localhost:11434/v1',
        modelName: 'llamablit',
        defaultTemperature: 0.7,
        defaultMaxTokens: 1024,
    },
    _coreAPI: null,
    _unsubscribe: null,
    _langchain: null,
    _uiSaveStatus: 'idle',
    _saveStatusTimeout: null,
    _debouncedSaveFunctions: {}, // Cache for debounced save functions per key
    _statusMessageTimeout: null, // Timeout ID for clearing status messages

    init(coreAPI) {
        this._coreAPI = coreAPI;
        console.log(`LLMPlugin: Initializing v${this.version}`);
        this._loadConfig();

        // Check config after initial load
        this._checkEssentialConfig();

        // Subscribe to settings changes to reload config if necessary
        // TODO: Enhancement #0 might make this subscription redundant or need modification
        this._unsubscribe = coreAPI.subscribe((newState, oldState) => {
            const settingsNote = this._coreAPI.getSystemNoteByType(`config/settings/${this.id}`);
            const oldSettingsNote = oldState.notes?.[settingsNote?.id];
            const newSettingsNote = newState.notes?.[settingsNote?.id];

            const propsChanged = settingsNote && (
                !oldSettingsNote ||
                JSON.stringify(newSettingsNote?.properties) !== JSON.stringify(oldSettingsNote?.properties)
            );

            const noteExistenceChanged = (!oldState.notes?.[settingsNote?.id] && newState.notes?.[settingsNote?.id]) ||
                (oldState.notes?.[settingsNote?.id] && !newState.notes?.[settingsNote?.id]);


            if (propsChanged || noteExistenceChanged) {
                console.log("LLMPlugin: Detected settings note change, reloading config.");
                this._loadConfig();
                this._checkEssentialConfig();
            }
        });
    },


    _loadConfig() {
        const settingsNote = this._coreAPI.getSystemNoteByType('config/settings/llm');
        let noteSettings = {};
        if (settingsNote) {
            try {
                const propsApi = this._coreAPI.getPluginAPI('properties');
                noteSettings = this._mapPropsToObject(propsApi?.getPropertiesForNote(settingsNote.id) || []);
                console.log("LLMPlugin: Loaded config from System Note 'config/settings/llm'");
            } catch (e) {
                console.error("LLMPlugin: Error parsing config/llm system note JSON.", e);
                this._coreAPI.showGlobalStatus("LLM Config Note Error: Invalid JSON.", "error", 5000);
            }
        } else {
            console.log("LLMPlugin: System Note 'config/llm' not found or empty.");
        }

        const mergedConfig = {
            ...this._config,
            ...(this._getDefaultSettings()),
            ...(noteSettings || {}),
        };

        this._config = {
            apiKey: mergedConfig.apiKey || null,
            endpointUrl: mergedConfig.endpointUrl || null,
            modelName: mergedConfig.modelName || null,
            defaultTemperature: mergedConfig.defaultTemperature ?? 0.7,
            defaultMaxTokens: mergedConfig.defaultMaxTokens ? parseInt(mergedConfig.defaultMaxTokens, 10) : 1024,
        };

        const logConfig = {...this._config};
        if (logConfig.apiKey && logConfig.apiKey.length > 3) {
            logConfig.apiKey = `********${logConfig.apiKey.slice(-3)}`;
        } else if (logConfig.apiKey) {
            logConfig.apiKey = '********';
        }
        console.log("LLMPlugin: Config loaded/updated", logConfig);
    },

    // --- Helper for Enhancement #0 ---
    _mapPropsToObject(properties = []) {
        const settings = {};
        properties.forEach(prop => {
            settings[prop.key] = prop.value;
        });
        return settings;
    },
    // --- Helper for Enhancement #0 ---
    _getDefaultSettings() {
        const defaults = {};
        const ontology = this.getSettingsOntology(); // Call own method
        if (!ontology) return defaults;

        for (const key in ontology) {
            if (ontology[key].hasOwnProperty('default')) {
                defaults[key] = ontology[key].default;
            }
        }
        return defaults;
    },


    // Check essential config and show warnings if needed
    _checkEssentialConfig() {
        // Check for Model Name - this is critical
        if (!this._config.modelName) {
            console.warn("LLMPlugin: Model Name is not configured.");
            // Show a persistent warning until configured
            this._coreAPI.showGlobalStatus(
                "LLMPlugin: Model Name required! Please configure it in settings.",
                "warning",
                0 // 0 duration makes it persistent until cleared or replaced
            );
        } else {
            // Optionally clear the warning if it was previously shown and now config is okay
            // This requires tracking the status message ID or content, which coreAPI might support.
            // If not, just showing a success/ready message might overwrite it:
            // this._coreAPI.showGlobalStatus("LLMPlugin: Ready.", "info", 2000);
        }

        // Check for API Key if using a non-local endpoint
        if (!this._config.apiKey && this._config.endpointUrl && !this._isLocalhostEndpoint(this._config.endpointUrl)) {
            console.warn("LLMPlugin: API Key might be required for the configured remote endpoint.");
            // Consider a less critical, timed warning for this
            this._coreAPI.showGlobalStatus(
                `LLMPlugin: API Key might be needed for ${this._config.endpointUrl}`,
                "warning",
                10000 // Show for 10 seconds
            );
        }
    },


    _isLocalhostEndpoint(url) {
        if (!url) return false;
        try {
            const parsedUrl = new URL(url);
            return ['localhost', '127.0.0.1', '[::1]'].includes(parsedUrl.hostname);
        } catch (e) {
            console.warn(`LLMPlugin: Invalid URL provided for endpoint check: ${url}`);
            return false;
        }
    },

    _getChatModelInstance(callOptions = {}) {
        const modelName = callOptions.model || this._config.modelName;
        const temperature = callOptions.temperature ?? this._config.defaultTemperature;
        const maxTokens = callOptions.max_tokens ?? this._config.defaultMaxTokens;
        const apiKey = this._config.apiKey;
        const baseURL = this._config.endpointUrl;

        if (!modelName) {
            this._coreAPI.showGlobalStatus("LLM Config Error: Model Name required.", "error", 5000);
            throw new Error("LLM Config Error: Model Name is required.");
        }
        const modelConfig = {
            model: modelName,
            temperature: temperature,
            maxTokens: maxTokens,
            apiKey: apiKey || undefined,
            streaming: callOptions.stream || false,
        };

        if (baseURL) {
            modelConfig.configuration = {baseURL: baseURL};
            console.log("LLMPlugin: Using custom baseURL for ChatModel:", baseURL);
        } else {
            console.log("LLMPlugin: Using default OpenAI baseURL for ChatModel.");
        }

        try {
            return new ChatOpenAI(modelConfig);
        } catch (error) {
            console.error("LLMPlugin: Error instantiating LangChain Chat Model:", error);
            this._coreAPI.showGlobalStatus(`LLM Init Error: ${error.message}`, "error", 5000);
            throw new Error(`Failed to initialize LLM Chat Model: ${error.message}`);
        }
    },

    _getEmbeddingsInstance(callOptions = {}) {
        // Use specific embedding config keys if they exist, otherwise fallback to main LLM config
        const modelName = callOptions.model || this._config.embeddingModelName || "text-embedding-ada-002"; // Default to OpenAI's ada-002 if not specified
        const apiKey = this._config.embeddingApiKey || this._config.apiKey;
        const baseURL = this._config.embeddingEndpointUrl || this._config.endpointUrl;

        const embeddingsConfig = {
            model: modelName,
            apiKey: apiKey || undefined,
        };

        if (baseURL) {
            embeddingsConfig.configuration = {baseURL: baseURL};
            console.log("LLMPlugin: Using custom baseURL for Embeddings:", baseURL);
        } else {
            console.log("LLMPlugin: Using default OpenAI baseURL for Embeddings.");
        }

        try {
            return new OpenAIEmbeddings(embeddingsConfig);
        } catch (error) {
            console.error("LLMPlugin: Error instantiating LangChain Embeddings Model:", error);
            this._coreAPI.showGlobalStatus(`Embeddings Init Error: ${error.message}`, "error", 5000);
            throw new Error(`Failed to initialize Embeddings Model: ${error.message}`);
        }
    },

    // --- Lifecycle Hooks ---
    onDeactivate() {
        console.log("LLMPlugin: Deactivating.");
        if (this._unsubscribe) {
            this._unsubscribe();
            this._unsubscribe = null;
        }
        // Clear any pending timeouts
        clearTimeout(this._saveStatusTimeout);
        clearTimeout(this._statusMessageTimeout); // Clear status message timeouts too
        // Clear debounced functions to avoid memory leaks
        for (const key in this._debouncedSaveFunctions) {
            if (this._debouncedSaveFunctions[key]?.cancel) { // Check if debounce lib provides cancel
                this._debouncedSaveFunctions[key].cancel();
            }
        }
        this._debouncedSaveFunctions = {};
        this._coreAPI = null; // Release reference to core API
        this._langchain = null; // Release langchain instance if stored
    },

    // --- Services Provided ---
    providesServices() {
        // Ensure 'this' context is correct within service methods
        const pluginInstance = this;
        return {
            'LLMService': {
                getCurrentConfig: () => {
                    return {...this._config};
                },

                /** wrapper for callLLM */
                /** wrapper for callLLM */
                prompt: async (prompt, options = {}) => {
                    if (!pluginInstance._coreAPI) throw new Error("LLMPlugin CoreAPI not available.");
                    const messages = [{role: 'user', content: prompt}];
                    // Use pluginInstance to access callLLM correctly
                    return pluginInstance.providesServices().LLMService.callLLM(messages, options);
                },

                callLLM: async (messages, options = {}) => {
                    if (!pluginInstance._coreAPI) throw new Error("LLMPlugin CoreAPI not available.");

                    const stream = options.stream || false;
                    const modelName = options.model || pluginInstance._config.modelName;

                    // Critical check: Ensure model name is configured *before* trying to get instance
                    if (!modelName) {
                        const errorMsg = "LLM Error: Model Name is not configured. Please set it in the LLM Plugin settings.";
                        pluginInstance._coreAPI.showGlobalStatus(errorMsg, "error", 10000);
                        console.error("LLMPlugin: callLLM failed - " + errorMsg);
                        throw new Error(errorMsg); // Throw to stop execution
                    }

                    console.log(`LLMPlugin: Calling LLM. Model: ${modelName}, Stream: ${stream}`);
                    pluginInstance._coreAPI.showGlobalStatus(`LLM: Calling ${modelName}...`, "info", 3000); // Short status update

                    try {
                        // Get model instance *after* checking config
                        const chatModel = pluginInstance._getChatModelInstance({...options, stream}); // Pass options down

                        const langchainMessages = messages.map(msg => {
                            switch (msg.role?.toLowerCase()) {
                                case 'user':
                                    return new HumanMessage(msg.content);
                                case 'assistant':
                                case 'ai':
                                    return new AIMessage(msg.content);
                                case 'system':
                                    return new SystemMessage(msg.content);
                                default:
                                    console.warn(`LLMPlugin: Unknown message role '${msg.role}', treating as human.`);
                                    return new HumanMessage(msg.content);
                            }
                        });

                        if (stream) {
                            const streamResponse = await chatModel.stream(langchainMessages);
                            console.log("LLMPlugin: Returning LangChain stream.");
                            const self = this;

                            async function* feedbackStreamWrapper() {
                                try {
                                    for await (const chunk of streamResponse) {
                                        yield chunk;
                                    }
                                    console.log("LLMPlugin: Stream finished successfully.");
                                    // Use pluginInstance here
                                    pluginInstance._coreAPI.showGlobalStatus(`LLM: ${modelName} stream complete.`, "success", 2000);
                                } catch (error) {
                                    console.error("LLMPlugin: Error during LangChain stream.", error);
                                    // Use pluginInstance here
                                    pluginInstance._coreAPI.showGlobalStatus(`LLM Stream Error: ${error.message}`, "error", 8000);
                                    throw error; // Re-throw to signal failure
                                }
                            }

                            return feedbackStreamWrapper();
                        } else {
                            const responseMessage = await chatModel.invoke(langchainMessages);
                            console.log("LLMPlugin: Received LangChain response."); // Avoid logging potentially large response content by default
                            // Use pluginInstance here
                            pluginInstance._coreAPI.showGlobalStatus(`LLM: ${modelName} call complete.`, "success", 2000);
                            return {
                                choices: [{
                                    message: { role: 'assistant', content: responseMessage?.content ?? '' },
                                    finish_reason: responseMessage?.response_metadata?.finishReason || responseMessage?.finishReason || 'stop',
                                }],
                                usage: responseMessage?.usageMetadata || undefined,
                            };
                        }
                    } catch (error) {
                        console.error("LLMPlugin: Error during LangChain call.", error);
                        // Use pluginInstance here. Avoid duplicating the "model name not configured" message.
                        const errorMsg = error.message === "LLM model name is not configured."
                            ? error.message // Use the specific config error message
                            : `LLM Call Error: ${error.message}`; // Generic error
                        pluginInstance._coreAPI.showGlobalStatus(errorMsg, "error", 8000);
                        throw error; // Re-throw the original error
                    }
                },

                summarizeText: async (text, options = {}) => {
                    if (!pluginInstance._coreAPI) return null; // Check core API
                    if (!text || typeof text !== 'string' || text.trim().length < 20) {
                        console.warn("LLMPlugin: Text too short or invalid for summarization.");
                        pluginInstance._coreAPI.showGlobalStatus("Text too short to summarize.", "warning", 3000);
                        return null;
                    }
                    const prompt = `Please summarize the following text concisely:\n\n---\n${text}\n---\n\nConcise Summary:`;
                    const summaryOptions = {...options, stream: false}; // Force non-stream

                    try {
                        // Use pluginInstance.providesServices().LLMService.prompt
                        const response = await pluginInstance.providesServices().LLMService.prompt(prompt, summaryOptions);
                        const summary = response?.choices?.[0]?.message?.content?.trim();
                        if (!summary) {
                            console.error("LLMPlugin: Could not extract summary from LLM response.");
                            throw new Error("LLM did not return a valid summary.");
                        }
                        return summary;
                    } catch (error) {
                        console.error("LLMPlugin: Summarization failed.", error);
                        // Status message already shown by callLLM/prompt if it's a config/call error
                        // Only show a generic one if the error is specific to summarization logic itself
                        if (!error.message.includes("LLM Error") && !error.message.includes("LLM Call Error")) {
                             pluginInstance._coreAPI.showGlobalStatus("Summarization processing failed.", "error", 5000);
                        }
                        return null; // Return null on failure
                    }
                },

                getActions: async (text, options = {}) => {
                     if (!pluginInstance._coreAPI) return null;
                    if (!text || typeof text !== 'string' || text.trim().length < 10) {
                        console.warn("LLMPlugin: Text too short for action generation.");
                        pluginInstance._coreAPI.showGlobalStatus("Text too short to suggest actions.", "warning", 3000);
                        return null;
                    }
                    const prompt = `Based on the following text, suggest a short list of actionable next steps or tasks (e.g., "Schedule meeting", "Draft email to X", "Research Y"). Output ONLY a numbered list. If no actions are clear, output "None".\n\n---\n${text}\n---\n\nNumbered List of Actions:`;
                    const actionOptions = { ...options, stream: false };

                    try {
                         // Use pluginInstance.providesServices().LLMService.prompt
                        const response = await pluginInstance.providesServices().LLMService.prompt(prompt, actionOptions);
                        const actionsText = response?.choices?.[0]?.message?.content?.trim();
                        if (!actionsText || actionsText.toLowerCase() === 'none' || actionsText.toLowerCase().startsWith("the answer is not found")) {
                             pluginInstance._coreAPI.showGlobalStatus("No specific actions suggested by AI.", "info", 3000);
                            return [];
                        }
                        // Basic parsing of numbered list
                        return actionsText.split('\n')
                            .map(line => line.replace(/^\d+\.\s*/, '').trim()) // Remove numbering
                            .map(line => line.replace(/^\d+[.)]?\s*/, '').trim()) // Remove numbering (more robust)
                            .filter(action => action.length > 0);
                    } catch (error) {
                        console.error("LLMPlugin: Action generation failed.", error);
                         if (!error.message.includes("LLM Error") && !error.message.includes("LLM Call Error")) {
                             pluginInstance._coreAPI.showGlobalStatus("Action suggestion processing failed.", "error", 5000);
                         }
                        return null;
                    }
                },

                answerQuestion: async (contextText, question, options = {}) => {
                     if (!pluginInstance._coreAPI) return null;
                     if (!contextText || typeof contextText !== 'string' || contextText.trim().length < 10) {
                        pluginInstance._coreAPI.showGlobalStatus("Context text too short to answer question.", "warning", 3000);
                        return null;
                    }
                     if (!question || typeof question !== 'string' || question.trim().length < 3) {
                        pluginInstance._coreAPI.showGlobalStatus("Please provide a valid question.", "warning", 3000);
                        return null;
                    }

                    const prompt = `Based *only* on the following text, answer the question concisely. If the answer is not found in the text, say "The answer is not found in the provided text."\n\nContext Text:\n---\n${contextText}\n---\n\nQuestion: ${question}\n\nAnswer:`;
                    const answerOptions = { ...options, stream: false };

                    try {
                         // Use pluginInstance.providesServices().LLMService.prompt
                        const response = await pluginInstance.providesServices().LLMService.prompt(prompt, answerOptions);
                        const answer = response?.choices?.[0]?.message?.content?.trim();
                        if (!answer) {
                            throw new Error("LLM did not return a valid answer.");
                        }
                        return answer;
                    } catch (error) {
                        console.error("LLMPlugin: Answering question failed.", error);
                         if (!error.message.includes("LLM Error") && !error.message.includes("LLM Call Error")) {
                             pluginInstance._coreAPI.showGlobalStatus("Error processing question answer.", "error", 5000);
                         }
                        return null;
                    }
                },

                /**
                 * Generates note content based on a template and properties using the LLM.
                 * @param {string} templateName - The name of the template to use (must exist in ontology).
                 * @param {Array<object>} properties - Array of property objects ({key, value, type}) for the current note.
                 * @param {object} [options={}] - Additional options for the LLM call (temperature, model, etc.).
                 * @returns {Promise<string|null>} The generated content string, or null on failure.
                 */
                generateContent: async (templateName, properties = [], options = {}) => {
                     if (!pluginInstance._coreAPI) return null;
                    const ontologyService = pluginInstance._coreAPI.getService('OntologyService');
                    if (!ontologyService) {
                        pluginInstance._coreAPI.showGlobalStatus("LLM Error: Ontology service unavailable.", "error", 5000);
                        console.error("LLMPlugin.generateContent: OntologyService not available.");
                        return null;
                    }

                    const templates = ontologyService.getTemplates();
                    const template = templates.find(t => t.name === templateName);

                    if (!template) {
                        pluginInstance._coreAPI.showGlobalStatus(`LLM Error: Template "${templateName}" not found.`, "error", 5000);
                        console.error(`LLMPlugin.generateContent: Template not found: ${templateName}`);
                        return null;
                    }

                    // Construct the prompt
                    let propertiesString = "Current Note Properties:\n";
                    if (properties.length > 0) {
                        properties.forEach(p => {
                            propertiesString += `- ${p.key}: ${p.value}\n`;
                        });
                    } else {
                        propertiesString += "- None\n";
                    }

                    const prompt = `
Generate note content based on the following template structure and property values.
Fill in the details logically based on the provided properties. If a property seems relevant to a template section but isn't provided, make a reasonable placeholder or omit it gracefully.
Adhere to the overall structure and tone suggested by the template.

Template Name: ${template.name}
Template Structure:
---
${template.content}
---

${propertiesString}

Generated Note Content:
`;
                    const generateOptions = { ...options, stream: false };

                    try {
                         // Use pluginInstance.providesServices().LLMService.prompt
                        const response = await pluginInstance.providesServices().LLMService.prompt(prompt, generateOptions);
                        const generatedContent = response?.choices?.[0]?.message?.content?.trim();
                        if (!generatedContent) {
                            throw new Error("LLM did not return valid content for generation.");
                        }
                        return generatedContent;
                    } catch (error) {
                        console.error("LLMPlugin: Content generation failed.", error);
                         if (!error.message.includes("LLM Error") && !error.message.includes("LLM Call Error")) {
                             pluginInstance._coreAPI.showGlobalStatus("AI Content Generation processing failed.", "error", 5000);
                         }
                        return null;
                    }
                },

                generateEmbeddings: async (text, options = {}) => {
                     if (!pluginInstance._coreAPI) throw new Error("LLMPlugin CoreAPI not available.");
                    if (!text || typeof text !== 'string') {
                        const errorMsg = "Embeddings Error: Input must be non-empty text.";
                        pluginInstance._coreAPI.showGlobalStatus(errorMsg, "error", 4000);
                        throw new Error(errorMsg);
                    }

                    console.log("LLMPlugin: Generating embeddings via LangChain.");
                    pluginInstance._coreAPI.showGlobalStatus("LLM: Generating embeddings...", "info", 3000);

                    try {
                        const embeddingsModel = pluginInstance._getEmbeddingsInstance(options);
                        const embeddingVector = await embeddingsModel.embedQuery(text);

                        if (!Array.isArray(embeddingVector) || embeddingVector.length === 0) {
                             console.error("LLMPlugin: Embeddings model returned invalid result (not an array or empty).", embeddingVector);
                            throw new Error("Embeddings model returned invalid result.");
                        }

                        console.log(`LLMPlugin: Embeddings generated (vector length: ${embeddingVector.length}).`);
                        pluginInstance._coreAPI.showGlobalStatus("Embeddings generated.", "success", 2000);
                        return embeddingVector;

                    } catch (error) {
                        console.error("LLMPlugin: Error generating embeddings.", error);
                        const errorMsg = `Embeddings Error: ${error.message}`;
                        pluginInstance._coreAPI.showGlobalStatus(errorMsg, "error", 8000);
                        throw error; // Re-throw the original error
                    }
                },
            }
        };
    },

    // --- Added for Enhancement #0 ---
    getSettingsOntology() {
        // Define the structure and metadata for this plugin's settings
        return {
            'apiKey': {
                type: 'password', label: 'API Key', order: 2,
                description: 'Required for most cloud services (OpenAI, Anthropic, etc.). Leave empty if the endpoint does not require a key (e.g., local Ollama).'
            },
            'endpointUrl': {
                type: 'url', label: 'Base URL (Endpoint)', order: 1,
                placeholder: 'e.g., http://localhost:11434/v1 or https://api.openai.com/v1',
                description: 'For OpenAI & compatible APIs (Ollama, LM Studio, etc.). Leave empty ONLY if Langchain defaults work for you (rarely).'
            },
            'modelName': {
                type: 'text', label: 'Model Name', required: true, order: 3,
                placeholder: 'e.g., gpt-4o, ollama/llama3, claude-3-haiku-20240307',
                description: 'Required. Must match a model available at your endpoint/service.'
            },
            'defaultTemperature': {
                type: 'number', label: 'Default Temperature', min: 0, max: 2, step: 0.1, default: 0.7, order: 4,
                description: 'Controls randomness (0=deterministic, ~0.7=balanced, >1=more random). Default: 0.7'
            },
            'defaultMaxTokens': {
                type: 'number', label: 'Default Max Tokens', min: 1, step: 1, default: 1024, order: 5,
                placeholder: 'e.g., 1024', description: 'Max completion length. Default: 1024. Check model limits.'
            }
        };
    },

    registerUISlots() {
        return {
            [SLOT_SETTINGS_PANEL_SECTION]: (props) => {
                const {state, dispatch} = props;
                const pluginId = this.id;
                const settingsOntology = this.getSettingsOntology();
                const settingsNote = this._coreAPI.getSystemNoteByType(`config/settings/${pluginId}`);
                const propsApi = this._coreAPI.getPluginAPI('properties');
                const currentProperties = settingsNote ? (propsApi?.getPropertiesForNote(settingsNote.id) || []) : [];

                // Convert current properties to a simple { key: value } map for easy lookup
                const currentValues = this._mapPropsToObject(currentProperties);

                // Get defaults from ontology definition
                const defaultValues = this._getDefaultSettings();

                const displayConfig = {
                    ...defaultValues, // Start with defaults
                    ...currentValues // Override with actual values from note properties
                };
                const isModelNameMissing = !displayConfig.modelName; // Check based on current/default value

                if (!settingsNote) {
                    // Render button to create the settings note
                    return html`
                        <div class="settings-section llm-settings">
                            <h4>${this.name}</h4>
                            <p>Settings note not found.</p>
                            <button @click=${() => dispatch({
                                type: 'CORE_ADD_NOTE', payload: {
                                    name: `${this.name} Settings`,
                                    systemType: `config/settings/${pluginId}`,
                                    content: `Stores configuration properties for the ${pluginId} plugin.`
                                }
                            })}>Create Settings Note
                            </button>
                        </div>
                    `;
                }


                // --- Debounced Save Handler using PROPERTY_ADD/UPDATE ---
                const createDebouncedSaver = (key, schema) => {
                    if (!this._debouncedSaveFunctions[key]) {
                        this._debouncedSaveFunctions[key] = this._coreAPI.utils.debounce((value) => {
                            console.log(`LLMPlugin: Saving setting ${key} =`, typeof value === 'string' && value.length > 50 ? value.substring(0, 50) + '...' : value); // Avoid logging long values like keys

                            const existingProp = currentProperties.find(p => p.key === key);
                            let actionType = 'PROPERTY_ADD';
                            let payload = {
                                noteId: settingsNote.id,
                                propertyData: {key: key, value: value, type: schema.type || 'text'}
                            };

                            if (existingProp) {
                                // Only dispatch update if value actually changed
                                if (existingProp.value !== value) {
                                    actionType = 'PROPERTY_UPDATE';
                                    payload = {
                                        noteId: settingsNote.id,
                                        propertyId: existingProp.id,
                                        changes: {value: value}
                                    };
                                    dispatch({type: actionType, payload: payload});
                                } else {
                                    // Value hasn't changed, don't dispatch anything
                                    return;
                                }
                            } else {
                                dispatch({type: actionType, payload: payload});
                            }

                            // Update UI status - REMOVED requestRender
                            clearTimeout(this._saveStatusTimeout);
                            this._uiSaveStatus = 'saved';
                            // Need to manually trigger re-render as dispatch doesn't guarantee immediate prop update reflection
                            //this._coreAPI.requestRender();

                            this._saveStatusTimeout = setTimeout(() => {
                                this._uiSaveStatus = 'idle';
                                //this._coreAPI.requestRender(); // Hide "Saved" message
                            }, 2000);

                        }, 750);
                    }
                    return this._debouncedSaveFunctions[key];
                };

                // --- Input Handlers ---
                const handleInput = (key, value) => {
                    createDebouncedSaver(key, settingsOntology[key])(value);
                };

                const handleNumberInput = (key, value, isFloat = false) => {
                    const number = isFloat ? parseFloat(value) : parseInt(value, 10);
                    if (!isNaN(number)) {
                        handleInput(key, number);
                    } else if (value === '') {
                        handleInput(key, null); // Save null when field is cleared
                    }
                };

                // --- Dynamic Form Rendering ---
                const sortedKeys = Object.keys(settingsOntology).sort((a, b) => (settingsOntology[a].order || 99) - (settingsOntology[b].order || 99));


                return html`
                    <div class="settings-section llm-settings">
                        <h4>
                            <span>${this.name}</span>
                            <span class="save-status ${this._uiSaveStatus === 'saved' ? 'visible' : ''}">Saved ✓</span>
                        </h4>
                        <p class="settings-description">
                            Configure LLM access. Settings are stored as properties on System Note: ${settingsNote.id}.
                            Autosaves on change.
                        </p>
                        ${isModelNameMissing ? html`<p class="settings-description warning">⚠️ Model Name is required
                            for the plugin to function. Please enter one below.</p>` : ''}


                        ${sortedKeys.map(key => {
                            const schema = settingsOntology[key];
                            const currentValue = displayConfig[key]; // Uses default if not set
                            const inputId = `llm-setting-${key}`;
                            let inputElement;
                            const isRequired = schema.required;

                            // Determine input type and common attributes
                            const commonAttrs = {
                                id: inputId,
                                '.value': currentValue ?? '', // Use ?? for null/undefined, ensuring empty string for input value
                                placeholder: schema.placeholder || '',
                                required: isRequired,
                                'aria-required': String(isRequired)
                            };
                            const style = (isRequired && !currentValue) ? 'border-color: var(--vscode-inputValidation-warningBorder, orange);' : '';


                            // TODO: Add support for select, checkbox, textarea based on schema.type
                            if (schema.type === 'number') {
                                inputElement = html`<input type="number" ...=${commonAttrs} style=${style}
                                                           min=${schema.min ?? ''} max=${schema.max ?? ''}
                                                           step=${schema.step ?? ''}
                                                           @input=${(e) => handleNumberInput(key, e.target.value, schema.step && String(schema.step).includes('.'))}>`;
                            } else if (schema.type === 'password') {
                                inputElement = html`<input type="password" ...=${commonAttrs} style=${style}
                                                           @input=${(e) => handleInput(key, e.target.value)}>`;
                            } else if (schema.type === 'url') {
                                inputElement = html`<input type="url" ...=${commonAttrs} style=${style}
                                                           @input=${(e) => handleInput(key, e.target.value.trim())}>`;
                            } else { // Default to text
                                inputElement = html`<input type="text" ...=${commonAttrs} style=${style}
                                                           @input=${(e) => handleInput(key, e.target.value.trim())}>`;
                            }

                            return html`
                                <div class="setting-item">
                                    <label for=${inputId}>${schema.label || key}${isRequired ? html`<span
                                            class="required-indicator">*</span>` : ''}</label>
                                    ${inputElement}
                                    ${schema.description ? html`<span
                                            class="field-hint">${schema.description}</span>` : ''}
                                </div>
                            `;
                        })}
                        <!-- Old hardcoded fields removed -->
                            <!--
                        </div>
                    </div>
                `;
            }
        }
    }
};

// Optional cleanup remains the same
LLMPlugin.cleanup = function() {
    console.log("LLMPlugin: Cleaning up.");
    if (this._unsubscribe) {
        this._unsubscribe();
        this._unsubscribe = null;
    }
    // Clear any pending timeouts
    clearTimeout(this._saveStatusTimeout);
    // Clear debounced functions to avoid memory leaks if plugin is re-initialized
    for (const key in this._debouncedSaveFunctions) {
        if (this._debouncedSaveFunctions[key].cancel) { // Check if debounce lib provides cancel
            this._debouncedSaveFunctions[key].cancel();
        }
    }
    this._debouncedSaveFunctions = {};
    this._coreAPI = null; // Release reference to core API
};
