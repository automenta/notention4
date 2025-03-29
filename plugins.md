Okay, here are pseudocode summaries for each planned plugin, focusing on integration points, interactions, and potential
decomposition.

**Core Integration Points Recap:**

* **`CoreAPI`:** Provided to plugins (`dispatch`, `getState`, `subscribe`, `getService`, helpers like `getNoteById`,
  `getSystemNoteByType`, `getPluginSettings`, `getRuntimeCache`, `showGlobalStatus`, `utils`).
* **`Plugin Definition`:** Specifies `id`, `name`, `dependencies`, and registration methods (`init`, `onActivate`,
  `registerReducer`, `registerMiddleware`, `registerUISlots`, `providesServices`, `getAPI`).
* **State:** Plugins manage their state via their single registered reducer, affecting `note.pluginData[pluginId]`,
  `pluginRuntimeState[pluginId]`, `settings.plugins[pluginId]`, `runtimeCache`.
* **UI Slots:** Plugins provide render functions for specific named slots.
* **Services:** Plugins consume services via `CoreAPI.getService` and provide them via `providesServices`.
* **Event Bus:** Used for decoupled notifications via `CoreAPI.publishEvent` / `CoreAPI.subscribeToEvent`.
* **System Notes:** Configuration loaded via `CoreAPI.getSystemNoteByType`.

---

**1. Properties Plugin (Foundation)**

* **Purpose:** Introduces the concept of structured `Property` objects associated with notes and handles their basic
  lifecycle.
* **Decomposition:** Generally atomic, foundational layer.
* **Plugin Definition:**
  ```javascript
  const PropertiesPlugin = {
      id: 'properties',
      name: 'Note Properties',
      init(coreAPI) { this.coreAPI = coreAPI; },
      registerReducer: () => (state, action) => {
          // Use Immer or similar for easier immutable updates recommended
          switch (action.type) {
              case 'CORE_ADD_NOTE': // Initialize pluginData for new notes
                  const newNoteId = state.noteOrder[0]; // Assumes core added it first
                  // Ensure pluginData structure exists before adding properties
                  const ns = state.notes[newNoteId];
                  if (!ns.pluginData) ns.pluginData = {};
                  ns.pluginData[this.id] = { properties: [] };
                  return state; // Return modified state using Immer draft or new object

              case 'PROPERTY_ADD': // payload: { noteId, propertyData }
                  const { noteId_add, propertyData } = action.payload;
                  const ps = state.notes[noteId_add];
                  if (!ps?.pluginData?.[this.id]) return state; // Ensure initialized
                  const newProp = { id: coreAPI.utils.generateUUID(), ...propertyData };
                  ps.pluginData[this.id].properties.push(newProp);
                  ps.updatedAt = Date.now(); // Mark note as updated
                  return state;

              case 'PROPERTY_UPDATE': // payload: { noteId, propertyId, changes }
                 const { noteId_upd, propertyId_upd, changes } = action.payload;
                 const noteProps = state.notes[noteId_upd]?.pluginData?.[this.id]?.properties;
                 if (!noteProps) return state;
                 const propIndex = noteProps.findIndex(p => p.id === propertyId_upd);
                 if (propIndex === -1) return state;
                 noteProps[propIndex] = { ...noteProps[propIndex], ...changes };
                 state.notes[noteId_upd].updatedAt = Date.now();
                 return state;

              case 'PROPERTY_DELETE': // payload: { noteId, propertyId }
                 const { noteId_del, propertyId_del } = action.payload;
                 const ds = state.notes[noteId_del]; 
                 const notePropsDel = ds?.pluginData?.[this.id]?.properties;
                 if (!notePropsDel) return state;
                 const initialLength = notePropsDel.length;
                 ds.pluginData[this.id].properties = notePropsDel.filter(p => p.id !== propertyId_del);
                 if (ds.pluginData[this.id].properties.length !== initialLength) ds.updatedAt = Date.now();
                 return state;

              // Potentially handle CORE_DELETE_NOTE to clean up related runtime state if any
          }
          return state; // Return unchanged state if action not handled
      },
      registerUISlots: () => ({
          [SLOT_EDITOR_BELOW_CONTENT]: (props) => {
              // Render UI: List properties from props.state.notes[props.noteId].pluginData.properties
              // Include "Add Property" button -> triggers PROPERTY_ADD action (via modal/popover)
              // Property Pill click -> opens detailed editor (popover/modal) -> triggers PROPERTY_UPDATE/DELETE
              return `<div class="properties-area">... Properties UI ...</div>`;
          }
          // Popover/Modal logic would be handled within the rendered component's event handlers
      }),
      // Optional: getAPI() to expose helpers like getPropertiesForNote(noteId)?
  };
  ```
* **Interaction:** Provides the `note.pluginData.properties` array used by Parser, Matcher, Nostr. Its reducer handles
  the core data manipulation actions for properties.

---

**2. Ontology Plugin**

* **Purpose:** Manages and provides shared semantic definitions (types, hints, templates, keywords).
* **Decomposition:** Generally atomic. Could split Templates if very complex.
* **Plugin Definition:**
  ```javascript
  const OntologyPlugin = {
      id: 'ontology',
      name: 'Ontology Manager',
      _ontologyData: null, // Internal cache
      _configNoteId: null,

      init(coreAPI) {
          this.coreAPI = coreAPI;
          this._loadOntology(); // Initial load
          // Subscribe to state changes to detect updates to the config note
          this.coreAPI.subscribe((newState, oldState) => {
              const newConfigNote = this.coreAPI.getSystemNoteByType('config/ontology');
              if (newConfigNote && (!this._configNoteId || newConfigNote.updatedAt !== oldState.notes[this._configNoteId]?.updatedAt)) {
                   console.log("OntologyPlugin: Config note changed, reloading...");
                   this._loadOntology(newConfigNote);
              } else if (!newConfigNote && this._configNoteId) {
                  console.log("OntologyPlugin: Config note deleted, clearing ontology.");
                  this._ontologyData = null;
                  this._configNoteId = null;
              }
          });
      },
      _loadOntology(note = null) {
          const configNote = note || this.coreAPI.getSystemNoteByType('config/ontology');
          this._configNoteId = configNote?.id || null;
          if (configNote && configNote.content) {
              try {
                  // Assume content is JSON or YAML defining types, hints, templates etc.
                  this._ontologyData = JSON.parse(configNote.content); // Or use YAML parser
                  console.log("OntologyPlugin: Ontology data loaded/reloaded.");
                  this.coreAPI.publishEvent('ONTOLOGY_LOADED', this._ontologyData);
              } catch (e) {
                  console.error("OntologyPlugin: Failed to parse config note content.", e);
                  this.coreAPI.showGlobalStatus("Error loading ontology configuration.", "error");
                  this._ontologyData = null; // Reset on error
              }
          } else {
               console.log("OntologyPlugin: No config note found or content empty.");
               this._ontologyData = null; // Default empty ontology
          }
      },
      providesServices: () => ({
          'OntologyService': {
              getHints: () => this._ontologyData?.hints || {},
              inferType: (value, nameHint) => { /* Logic using this._ontologyData?.rules */ return 'text'; },
              getUIHints: (property) => { /* Logic using this._ontologyData?.uiHints */ return { icon: ' M ', color: '#ccc' }; },
              getTemplates: () => this._ontologyData?.templates || [],
              // Add more specific getters as needed
          }
      }),
      registerUISlots: () => ({
          [SLOT_SETTINGS_PANEL_SECTION]: (props) => {
              // Render UI to find/edit the 'config/ontology' System Note
              // Maybe provide a structured editor or just link to the note
              const configNote = this.coreAPI.getSystemNoteByType('config/ontology');
              const noteId = configNote?.id;
              if (noteId) {
                  return `<div>Ontology Config: <button onclick="coreAPI.dispatch({type:'CORE_SELECT_NOTE', payload:{noteId:'${noteId}'}}); coreAPI.dispatch({type:'CORE_CLOSE_MODAL'})">Edit Note</button></div>`;
              } else {
                  return `<div><button onclick="coreAPI.dispatch({type:'CORE_ADD_NOTE', payload:{name:'Ontology Config', systemType:'config/ontology', content:'{\\"hints\\":{}, \\"rules\\": [], \\"templates\\":[]}' }})">Create Ontology Config Note</button></div>`;
              }
          }
      }),
      // No primary reducer needed if config is loaded reactively via subscribe
  };
  ```
* **Interaction:** Provides `OntologyService` used by Properties, Parser, Matcher, AI Interviewer. Reacts to
  `CORE_UPDATE_NOTE` for its specific System Note.

---

**3. Semantic Parser Plugin(s)**

* **Purpose:** Extract structured Properties from unstructured note content.
* **Decomposition:** Recommended:
    * `Parser.Core`: Orchestrates parsing, manages suggestions state. Provides `SemanticParserService`.
    * `Parser.Heuristic`: Implements basic regex/keyword parsing logic.
    * `Parser.LLM`: Implements LLM-based parsing logic. (Depends on `LLMPlugin`).
    * `Parser.UI`: Handles inline UI decorations and confirmation popovers. (Depends on `EditorPlugin`/`EditorService`).
* **Combined Summary (Illustrative):**
  ```javascript
  const SemanticParserPlugin = {
      id: 'parser',
      name: 'Semantic Parser',
      dependencies: ['ontology', 'properties'], // Optional: 'llm', 'editor'

      init(coreAPI) {
          this.coreAPI = coreAPI;
          this.ontologyService = coreAPI.getService('OntologyService');
          this.llmService = coreAPI.getService('LLMService'); // May be null
          this.editorService = coreAPI.getService('EditorService'); // May be null
      },

      registerMiddleware: () => storeApi => next => action => {
          // Watch for content changes to trigger parsing (debounced)
          if (action.type === 'CORE_UPDATE_NOTE' && action.payload.changes.hasOwnProperty('content')) {
              const noteId = action.payload.noteId;
              this._debouncedParse(noteId, action.payload.changes.content);
          }
          // Watch for selection changes to potentially clear suggestions?
          if (action.type === 'CORE_SELECT_NOTE') {
               // Maybe clear suggestions for previously selected note
               // storeApi.dispatch({ type: 'PARSER_CLEAR_SUGGESTIONS', payload: { noteId: storeApi.getState().uiState.selectedNoteId }});
          }
          return next(action); // Pass action along
      },
      _debouncedParse: Utils.debounce((noteId, content) => {
          console.log(`Parser: Debounced trigger for note ${noteId}`);
          // Use this.llmService if available, else fallback to heuristic
          const parseFn = this.llmService ? this._parseWithLLM : this._parseWithHeuristics;
          parseFn(content, noteId).then(suggestions => {
              this.coreAPI.dispatch({ type: 'PARSER_SUGGESTIONS_RECEIVED', payload: { noteId, suggestions } });
          }).catch(err => {
               console.error("Parser: Error during parsing", err);
               this.coreAPI.showGlobalStatus("Error parsing note content.", "error");
          });
      }, 500), // Debounce time

      async _parseWithLLM(content, noteId) { /* Call LLMService, format results */ return []; },
      async _parseWithHeuristics(content, noteId) { /* Use regex/keywords from OntologyService */ return []; },

      registerReducer: () => (state, action) => {
          // Manage suggestion state in pluginRuntimeState.parser.suggestions[noteId]
          switch (action.type) {
              case 'PARSER_SUGGESTIONS_RECEIVED':
                   const { noteId, suggestions } = action.payload;
                   // Update runtime state with new suggestions, potentially merging/clearing old ones
                   if (!state.pluginRuntimeState.parser) state.pluginRuntimeState.parser = {};
                   state.pluginRuntimeState.parser.suggestions = { ...(state.pluginRuntimeState.parser.suggestions || {}), [noteId]: suggestions };
                   return state;
              case 'PARSER_CLEAR_SUGGESTIONS': // Action to clear suggestions for a note
                   // ... clear state.pluginRuntimeState.parser.suggestions[action.payload.noteId] ...
                   return state;
               // Action 'PARSER_CONFIRM_SUGGESTION' (payload: { noteId, suggestion })
               //  -> Dispatches PROPERTY_ADD or PROPERTY_UPDATE via middleware or thunk action
               // Action 'PARSER_IGNORE_SUGGESTION' (payload: { noteId, suggestionId })
               //  -> Updates suggestion state (marks as ignored) in pluginRuntimeState
          }
          return state;
      },

      registerUISlots: () => ({
           // If using EditorService, UI is handled via decorations applied through the service.
           // If no EditorService, might render overlays in SLOT_EDITOR_CONTENT_AREA (complex).
           // Also needs logic for popover/modal on suggestion click (handled by decoration/overlay event listeners).
      }),
      providesServices: () => ({
          // Optional: Expose service for fine-grained value parsing
           'SemanticParserService': {
               parsePropertyValue: (value, nameHint) => { /* Use OntologyService etc. */ return { structuredValue: value, type: 'text', state: 'is' }; }
           }
      })
  };
  ```
* **Interaction:** Uses `OntologyService`, `LLMService`. Interacts with `EditorService` for UI. Dispatches actions
  handled by `PropertiesPlugin`. Listens for `CORE_UPDATE_NOTE`. Manages state in `pluginRuntimeState`.

---

**4. Rich Text Editor Plugin**

Choose a robust, reliable, and extensible Rich Text Editor to import... or create one using 'contenteditable'.

* **Purpose:** Provide a rich editing experience and an API for interaction.
* **Plugin Definition:**
  ```javascript
  const RichTextEditorPlugin = {
      id: 'editor',
      name: 'Rich Text Editor',
      _editorInstance: null, // Holds editor implementation instance

      init(coreAPI) { this.coreAPI = coreAPI; /* Setup library config */ },
      onActivate() { /* Initialize editor instance if not done in slot rendering */ },
      onDeactivate() { this._editorInstance?.destroy(); },

      registerUISlots: () => ({
          [SLOT_EDITOR_CONTENT_AREA]: (props) => {
              // Mount point for the editor library (e.g., <div id="editor-mount"></div>)
              // This function likely initializes the editor instance on first render for a note
              // and updates its content when props.noteId changes or props.state.notes[noteId].content changes *externally*.
              const note = props.noteId ? props.state.notes[props.noteId] : null;
              if (this._editorInstance) {
                  // Logic to update content if note changed or content changed externally
                  const currentEditorContent = this.getContent(); // Get content from editor instance
                  if (note && currentEditorContent !== note.content) {
                       this._editorInstance.setContent(note.content || ''); // Update editor
                  } else if (!note) {
                      this._editorInstance.setContent(''); // Clear editor if no note selected
                  }
              } else if (note) {
                  // Initialize editor instance here, attaching to the mount point
                   this._editorInstance = new EditorLibrary('#editor-mount', {
                       content: note.content,
                       onChange: Utils.debounce(() => {
                           const newContent = this.getContent();
                           // Avoid dispatching if content hasn't actually changed, or if update came from external source
                           if (newContent !== props.state.notes[props.noteId]?.content) {
                               props.dispatch({ type: 'CORE_UPDATE_NOTE', payload: { noteId: props.noteId, changes: { content: newContent }}});
                           }
                       }, 500),
                       // ... other editor config ...
                   });
              }
              return `<div id="editor-mount"></div>`; // Editor library mounts here
          }
      }),
      providesServices: () => ({
          'EditorService': { // API for other plugins
              getContent: () => this._editorInstance?.getContent() || '',
              setContent: (content) => this._editorInstance?.setContent(content),
              getSelection: () => this._editorInstance?.getSelection(),
              applyDecoration: (range, attrs) => { /* Call editor API to add inline style/node */ },
              registerCommand: (name, commandFn) => { /* Call editor API */ },
              // ... other necessary editor interactions
          }
      }),
      // Reducer might listen to CORE_SELECT_NOTE to trigger content loading if slot rendering doesn't handle it robustly.
  };
  ```
* **Interaction:** Replaces core textarea. Dispatches `CORE_UPDATE_NOTE`. Provides `EditorService` used by `Parser.UI`.
  Listens for `CORE_SELECT_NOTE` / state changes to update its internal content.

---

**5. Nostr Plugin(s)**

// --- System Note for Encrypted Identity ---
// Location: System Note with type 'config/nostr/identity'
// Content Structure (Example):
// {
//   "version": 1,
//   "pubkey": "hex-encoded-public-key", // Stored unencrypted for quick lookup/display
//   "encryptedNsec": {
//      "ciphertext": "base64-encoded-ciphertext", // Result of AES-GCM encryption
//      "iv": "base64-encoded-initialization-vector", // For AES
//      "salt": "base64-encoded-salt" // For PBKDF2
// // KDF iterations, algorithm identifiers (e.g., PBKDF2-SHA256, AES-256-GCM)
// // could also be stored if needed for future flexibility.
// }
// }
// --- OR if no identity is stored ---
// null or empty object {}

const NostrPlugin = {
id: 'nostr',
name: 'Nostr Network',
dependencies: ['properties'], // Optional: 'matcher'

    init(coreAPI) {
        this.coreAPI = coreAPI;
        this.matcherService = coreAPI.getService('MatcherService');
        this._nostrWorker = null; // Consider using a Web Worker for crypto + network
        this._decryptedNsec = null; // In-memory store for the decrypted key (Session only!)
        this._identityStatus = 'loading'; // 'loading', 'locked', 'unlocked', 'no_identity', 'error'
        this._loadConfigAndCheckIdentity();
        // No auto-connect here, needs unlock first
    },

    // **NEW**: Load relay config AND check for stored identity
    async _loadConfigAndCheckIdentity() {
        const settings = this.coreAPI.getPluginSettings(this.id);
        const relayNote = this.coreAPI.getSystemNoteByType('config/nostr/relays');
        this._config = { /* Merge settings and relayNote content for RELAYS */ };

        const identityNote = this.coreAPI.getSystemNoteByType('config/nostr/identity');
        if (identityNote?.content && identityNote.content.encryptedNsec) {
            this._identityStatus = 'locked';
            this.coreAPI.dispatch({ type: 'NOSTR_IDENTITY_STATUS_UPDATE', payload: 'locked', pubkey: identityNote.content.pubkey });
            // Maybe automatically prompt for passphrase here? Or wait for user action.
        } else {
            this._identityStatus = 'no_identity';
             this.coreAPI.dispatch({ type: 'NOSTR_IDENTITY_STATUS_UPDATE', payload: 'no_identity' });
        }
    },

    // **NEW**: Prompt user for passphrase and attempt decryption
    async _unlockIdentity(passphrase) {
        const identityNote = this.coreAPI.getSystemNoteByType('config/nostr/identity');
        if (this._identityStatus !== 'locked' || !identityNote?.content?.encryptedNsec) {
            console.error("No locked identity to unlock.");
            return false;
        }

        const { encryptedNsec, pubkey } = identityNote.content;
        try {
            // --- Crypto Operations (Use Web Crypto API) ---
            // 1. Derive key from passphrase + stored salt using PBKDF2
            const derivedKey = await deriveKey(passphrase, decodeBase64(encryptedNsec.salt));
            // 2. Decrypt ciphertext using derived key + stored IV using AES-GCM
            const decryptedPrivateKeyBytes = await decrypt(derivedKey, decodeBase64(encryptedNsec.iv), decodeBase64(encryptedNsec.ciphertext));
            // 3. Convert decrypted bytes to nsec format (or use bytes directly)
            const nsec = bytesToNsec(decryptedPrivateKeyBytes); // Or hex private key
            // 4. **VERIFY:** Derive pubkey from decrypted private key and compare with stored pubkey
            const derivedPubkey = getPublicKey(nsecToHex(nsec)); // Or from bytes
            if (derivedPubkey !== pubkey) {
                throw new Error("Decryption failed: Public key mismatch.");
            }
            // --- Success ---
            this._decryptedNsec = nsec; // STORE IN MEMORY ONLY
            this._identityStatus = 'unlocked';
            this.coreAPI.dispatch({ type: 'NOSTR_IDENTITY_STATUS_UPDATE', payload: 'unlocked', pubkey: pubkey });
            // Automatically connect now?
            this.coreAPI.getService('NostrService')?.connect();
            return true;
        } catch (error) {
            console.error("Nostr identity unlock failed:", error);
             this._identityStatus = 'locked'; // Remain locked
             this.coreAPI.dispatch({ type: 'NOSTR_IDENTITY_STATUS_UPDATE', payload: 'error', error: 'Incorrect passphrase or corrupted data.' });
             this.coreAPI.showToast("Error: Incorrect passphrase or corrupted data.", "error");
             return false;
        } finally {
            // Clear passphrase from memory immediately
            passphrase = null;
        }
    },

    // **NEW**: Encrypt and store a new/imported identity
    async _storeIdentity(nsec, passphrase) {
        // **WARN USER** if passphrase is blank
        if (!passphrase) {
            const confirmed = await this.coreAPI.showConfirmationDialog({
                 title: "Security Warning",
                 message: "You are saving your Nostr key without a passphrase. Anyone with access to this browser's data could potentially use your key. Are you sure?",
                 confirmText: "Yes, save without passphrase",
                 cancelText: "Cancel"
             });
            if (!confirmed) return false;
        }

         try {
             const hexPrivKey = nsecToHex(nsec); // Or work with bytes directly
             const pubkey = getPublicKey(hexPrivKey);
             // --- Crypto Operations (Use Web Crypto API) ---
             // 1. Generate new random salt (for PBKDF2) and IV (for AES-GCM)
             const salt = generateRandomBytes(16);
             const iv = generateRandomBytes(12);
             // 2. Derive key from passphrase + salt using PBKDF2
             const derivedKey = await deriveKey(passphrase, salt);
             // 3. Encrypt private key bytes using derived key + IV with AES-GCM
             const ciphertext = await encrypt(derivedKey, iv, hexToBytes(hexPrivKey)); // Encrypt raw bytes preferably

             // 4. Prepare data for storage
             const identityData = {
                 version: 1,
                 pubkey: pubkey,
                 encryptedNsec: {
                     ciphertext: encodeBase64(ciphertext),
                     iv: encodeBase64(iv),
                     salt: encodeBase64(salt)
                 }
             };
             // 5. Save to system note
             await this.coreAPI.saveSystemNote('config/nostr/identity', identityData);

             // --- Success ---
             this._decryptedNsec = nsec; // Store in memory for current session
             this._identityStatus = 'unlocked';
             this.coreAPI.dispatch({ type: 'NOSTR_IDENTITY_STATUS_UPDATE', payload: 'unlocked', pubkey: pubkey });
             this.coreAPI.showToast("Nostr identity saved and unlocked.", "success");
             // Automatically connect now?
             this.coreAPI.getService('NostrService')?.connect();
             return true;
         } catch (error) {
             console.error("Failed to store Nostr identity:", error);
             this._identityStatus = 'error';
             this.coreAPI.dispatch({ type: 'NOSTR_IDENTITY_STATUS_UPDATE', payload: 'error', error: 'Failed to encrypt or save identity.' });
             this.coreAPI.showToast("Error: Failed to save identity.", "error");
             return false;
         } finally {
             // Clear sensitive data from memory
             passphrase = null;
             nsec = null; // Clear original nsec if passed directly
         }
    },

    // **NEW**: Clear identity from memory and optionally from storage
    async _lockOrClearIdentity(clearStorage = false) {
         this._decryptedNsec = null;
         if (clearStorage) {
             await this.coreAPI.saveSystemNote('config/nostr/identity', {}); // Clear note content
             this._identityStatus = 'no_identity';
             this.coreAPI.dispatch({ type: 'NOSTR_IDENTITY_STATUS_UPDATE', payload: 'no_identity' });
             this.coreAPI.showToast("Nostr identity cleared.", "info");
         } else {
             const identityNote = this.coreAPI.getSystemNoteByType('config/nostr/identity');
             if (identityNote?.content?.encryptedNsec) {
                  this._identityStatus = 'locked';
                  this.coreAPI.dispatch({ type: 'NOSTR_IDENTITY_STATUS_UPDATE', payload: 'locked', pubkey: identityNote.content.pubkey });
             } else {
                  this._identityStatus = 'no_identity';
                  this.coreAPI.dispatch({ type: 'NOSTR_IDENTITY_STATUS_UPDATE', payload: 'no_identity' });
             }
         }
         this.coreAPI.getService('NostrService')?.disconnect(); // Disconnect on lock/clear
    },

    onActivate() {
        // Don't auto-connect. Check status. If locked, maybe prompt?
        if (this._identityStatus === 'locked') {
            // Option 1: Do nothing, wait for user to unlock via UI
            // Option 2: Automatically show unlock modal
             this.coreAPI.showModal(/* Passphrase input modal */);
        } else if (this._identityStatus === 'unlocked') {
             this.coreAPI.getService('NostrService')?.connect();
        }
    },

    providesServices: () => ({
         // NostrService now implicitly uses this._decryptedNsec for signing
         'NostrService': {
             connect: () => { /* Connect logic, requires _identityStatus === 'unlocked' */ },
             disconnect: () => { /* Disconnect logic */ },
             signEvent: async (eventTemplate) => {
                 if (this._identityStatus !== 'unlocked' || !this._decryptedNsec) {
                     throw new Error("Nostr identity is locked or unavailable.");
                     // Or: could trigger unlock prompt here? Risky if signing happens automatically.
                 }
                 // Use this._decryptedNsec (or derived hex key) to sign
                 const signedEvent = await signEvent(eventTemplate, this._decryptedNsec); // Adapt based on nostr-tools usage
                 return signedEvent;
             },
             publishEvent: async (event) => { /* Use internal signEvent, then publish */},
             subscribe: (filters) => { /* Subscribe logic */ },
             getPublicKey: () => {
                if (this._identityStatus === 'unlocked' && this._decryptedNsec) {
                    return getPublicKey(nsecToHex(this._decryptedNsec));
                }
                const identityNote = this.coreAPI.getSystemNoteByType('config/nostr/identity');
                return identityNote?.content?.pubkey || null; // Return stored pubkey if locked/available
             },
             isUnlocked: () => this._identityStatus === 'unlocked',
             // Expose unlock/lock/clear methods? Or keep them internal to plugin?
             // Maybe better to trigger via Actions/UI for security.
         }
    }),

    registerReducer: () => (state, action) => {
        // Manage state:
        // pluginRuntimeState.nostr.connectionStatus ('connected', 'disconnected', 'connecting', 'error')
        // pluginRuntimeState.nostr.identityStatus ('loading', 'locked', 'unlocked', 'no_identity', 'error')
        // pluginRuntimeState.nostr.identityError (string | null)
        // pluginRuntimeState.nostr.publicKey (hex string | null) - Public key of current identity, even if locked
        // pluginRuntimeState.nostr.pendingMatches[noteId]
        // runtimeCache.nostrProfiles[pubkey]
        // note.pluginData.nostr = { eventId, rootEventId, isShared, isDeleted, lastSyncHash, etc. }
        switch (action.type) {
            // ** NEW/REVISED Identity Actions **
            case 'NOSTR_IDENTITY_STATUS_UPDATE':
                return {
                    ...state,
                    pluginRuntimeState: {
                        ...state.pluginRuntimeState,
                        nostr: {
                            ...state.pluginRuntimeState?.nostr,
                            identityStatus: action.payload,
                            publicKey: action.pubkey || state.pluginRuntimeState?.nostr?.publicKey || null, // Keep pubkey if locking
                            identityError: action.error || null,
                        }
                    }
                };
            case 'NOSTR_UNLOCK_REQUEST': // payload: { passphrase }
                // Trigger internal _unlockIdentity(action.payload.passphrase)
                // Update status to 'loading' or keep 'locked' during attempt?
                // Handled internally by plugin instance, dispatches _STATUS_UPDATE
                break;
            case 'NOSTR_SETUP_IDENTITY_REQUEST': // payload: { nsec, passphrase }
                // Trigger internal _storeIdentity(action.payload.nsec, action.payload.passphrase)
                // Handled internally, dispatches _STATUS_UPDATE
                break;
            case 'NOSTR_LOCK_REQUEST':
                // Trigger internal _lockOrClearIdentity(false)
                // Handled internally, dispatches _STATUS_UPDATE
                break;
             case 'NOSTR_CLEAR_IDENTITY_REQUEST':
                // Trigger internal _lockOrClearIdentity(true)
                // Handled internally, dispatches _STATUS_UPDATE
                break;

            // --- Other Actions (Largely Unchanged) ---
            case 'NOSTR_CONNECT_REQUEST': /* Update status to 'connecting' */ break;
            case 'NOSTR_CONNECTED': /* Update status to 'connected' */ break;
            case 'NOSTR_DISCONNECTED': /* Update status */ break;
            case 'NOSTR_PUBLISH_REQUEST': // payload: { noteId }
                // Mark note as publishing in pluginRuntimeState?
                break;
            case 'NOSTR_PUBLISH_SUCCESS': // payload: { noteId, eventId, publishedAt }
                // Update note.pluginData.nostr, clear publishing state
                break;
            case 'NOSTR_EVENT_RECEIVED': // payload: { event }
                // Handle profiles (Kind 0) -> update runtimeCache, dispatch PROFILE_UPDATE?
                // Handle potential matches -> use MatcherService -> dispatch NOSTR_MATCH_FOUND
                break;
            case 'NOSTR_MATCH_FOUND': // payload: { localNoteId, matchData: { note, score, explanation } }
                 // Update pluginRuntimeState.nostr.matches[localNoteId]
                 break;
            case 'CORE_UPDATE_NOTE':
                 // Check if noteId is shared and needs republishing
                 // Calculate content hash, compare with lastSyncHash
                 // If changed -> dispatch NOSTR_PUBLISH_REQUEST
                 break;
             // Handle changes to config note (relays)
             case 'CORE_SYSTEM_NOTE_UPDATED':
                 if (action.payload.type === 'config/nostr/relays') {
                     // Reload relay config, maybe reconnect?
                 }
                 // Don't trigger identity reload here - managed internally
                 break;
        }
        return state;
    },

    registerUISlots: () => ({
        [SLOT_EDITOR_HEADER_ACTIONS]: (props) => { /* Render Share Toggle, Sync Status (Requires unlocked state?) */ },
        [SLOT_NOTE_LIST_ITEM_STATUS]: (props) => { /* Render 🌐/☁️ icon based on note.pluginData.nostr.isShared */ },
        [SLOT_EDITOR_PLUGIN_PANELS]: (props) => { /* Render Matches list from pluginRuntimeState */ },
        // ** REVISED Settings Panel **
        [SLOT_SETTINGS_PANEL_SECTION]: (props) => {
            // Render Identity section based on pluginRuntimeState.nostr.identityStatus
            // If 'no_identity': Show "Setup Identity" (Generate / Import nsec + Set Passphrase)
            // If 'locked': Show "Unlock" (Passphrase input), Display Locked Status, Show Public Key (if available)
            // If 'unlocked': Show "Locked" status, Display Public Key, Options: "Lock", "Change Passphrase", "Clear Identity"
            // If 'error': Show error message, maybe retry unlock?
            // **CRITICAL WARNINGS** about passphrase security and recovery must be prominent here.
            // Render Relays link/editor (from _config)
        },
        // ** REVISED Status Bar **
        [SLOT_APP_STATUS_BAR]: (props) => {
             // Render connection status + Identity Status (e.g., 🔓 Unlocked / 🔒 Locked / ⚠️ No Identity)
             // Clicking 'Locked' could trigger unlock prompt.
        },
        // ** NEW potential slot/mechanism **
        // A modal component for passphrase entry, triggered by coreAPI.showModal(...)
    }),

};

// Helper functions (conceptual - implement using Web Crypto API)
async function deriveKey(passphrase, salt) { /* PBKDF2 logic */ }
async function encrypt(key, iv, data) { /* AES-GCM encryption logic */ }
async function decrypt(key, iv, ciphertext) { /* AES-GCM decryption logic */ }
function generateRandomBytes(length) { /* Secure random bytes */ }
function encodeBase64(bytes) { /* Base64 encoding */ }
function decodeBase64(str) { /* Base64 decoding */ }
function nsecToHex(nsec) { /* Convert nsec bech32 to hex private key */ }
function hexToBytes(hex) { /* Convert hex string to Uint8Array */ }
function bytesToNsec(bytes) { /* Convert raw private key bytes to nsec bech32 */ }
// Use functions from nostr-tools where appropriate (getPublicKey, signEvent etc.)

---

**6. Matcher Plugin(s)**

* **Purpose:** Calculate semantic compatibility score between two notes.
* **Decomposition:** Recommended:
    * `Matcher.PropertyLogic`: Core property comparison.
    * `Matcher.Vector`: Embedding generation and comparison (Depends on `LLMPlugin`).
    * `Matcher.Service`: Combines scores, provides the main `MatcherService`.
* **Combined Summary (Illustrative):**
  ```javascript
  const MatcherPlugin = {
      id: 'matcher',
      name: 'Semantic Matcher',
      dependencies: ['ontology', 'properties'], // Optional: 'llm'

      init(coreAPI) {
          this.coreAPI = coreAPI;
          this.ontologyService = coreAPI.getService('OntologyService');
          this.llmService = coreAPI.getService('LLMService'); // May be null
      },
      providesServices: () => ({
          'MatcherService': {
              calculateCompatibility: async (noteA, noteB) => {
                  const propsA = noteA?.pluginData?.properties?.properties || [];
                  const propsB = noteB?.pluginData?.properties?.properties || [];

                  // 1. Calculate Property Score
                  const propScoreResult = this._calculatePropertyScore(propsA, propsB);

                  // 2. Calculate Vector Score (if LLM available)
                  let vectorScoreResult = { score: 0, explanation: "Vector matching disabled." };
                  if (this.llmService) {
                       vectorScoreResult = await this._calculateVectorScore(noteA, noteB);
                  }

                  // 3. Combine Scores (weighted average?)
                  const finalScore = (propScoreResult.score * 0.7) + (vectorScoreResult.score * 0.3);
                  const explanation = `Property Match: ${propScoreResult.explanation}\nVector Match: ${vectorScoreResult.explanation}`;

                  return { score: finalScore, explanation };
              },
          }
      }),
      _calculatePropertyScore(propsA, propsB) {
          // Use this.ontologyService
          // Compare properties based on type ('is'/'wants', ranges, locations, tags etc.)
          let score = 0; let explanation = "No overlap.";
          // ... complex comparison logic ...
          return { score, explanation };
      },
      async _calculateVectorScore(noteA, noteB) {
           // Use this.llmService.generateEmbeddings (needs to exist)
           // Cache embeddings in runtimeCache or note.pluginData?
           // Calculate cosine similarity
           return { score: 0, explanation: "Not implemented." };
      },
      // Reducer might manage embedding cache if implemented
  };
  ```
* **Interaction:** Provides `MatcherService` used by `Nostr.Matcher`. Uses `OntologyService`, `LLMService`. Reads
  `note.pluginData.properties`.

---

**7. LLM Plugin**

* **Purpose:** Centralized access to Language Models. Use langchain.js for access to and configurations for various LM
  providers.
* **Plugin Definition:**
  ```javascript
  const LLMPlugin = {
      id: 'llm',
      name: 'Language Model Interface',
      _config: {},

      init(coreAPI) {
          this.coreAPI = coreAPI;
          this._loadConfig();
           // Subscribe to config changes
           coreAPI.subscribe((newState, oldState) => {
               const newSettings = coreAPI.getPluginSettings(this.id);
               // Check if relevant settings changed compared to oldState
               // If so, call this._loadConfig() again.
           });
      },
       _loadConfig() {
          // Prioritize settings.plugins.llm (potentially more secure for API key)
          // Fallback to System Note 'config/llm' for endpoint/model?
          const settings = this.coreAPI.getPluginSettings(this.id);
          const configNote = this.coreAPI.getSystemNoteByType('config/llm');
          let noteConfig = {};
          if (configNote?.content) try { noteConfig = JSON.parse(configNote.content); } catch(e){}
          this._config = { ...noteConfig, ...settings }; // Settings override note
          console.log("LLMPlugin: Config loaded/updated", this._config);
       },
      providesServices: () => ({
          'LLMService': {
              callLLM: async (promptPayload, options = {}) => {
                  const apiKey = this._config.apiKey;
                  const endpoint = this._config.endpointUrl || 'default_openai_compatible_endpoint';
                  // Add model selection logic based on this._config.modelName
                  if (!apiKey || !endpoint) throw new Error("LLM not configured.");
                  // Use fetch API to call the endpoint (OpenAI/Ollama compatible format)
                  // Handle streaming responses if needed
                  const response = await fetch(endpoint, { /* ... headers, body ... */ });
                  if (!response.ok) throw new Error(`LLM API error: ${response.statusText}`);
                  return response.json();
              },
               // Optional: Add specific helpers
               generateEmbeddings: async (text) => { /* Call embedding endpoint */ return []; },
               summarizeText: async (text) => { /* Construct prompt, call callLLM */ return ""; },
          }
      }),
      registerUISlots: () => ({
          [SLOT_SETTINGS_PANEL_SECTION]: (props) => {
               // Render UI for Endpoint URL, API Key (masked), Model Name
               // Save changes via CORE_SET_PLUGIN_SETTING
               // Link to System Note if using it for some config
               return `<div>LLM Settings UI... API Key: <input type='password'>...</div>`;
          }
      }),
      // Reducer listens for CORE_SET_PLUGIN_SETTING for its own ID to update internal config cache if needed
  };
  ```
* **Interaction:** Provides `LLMService` used by `Parser.LLM`, `Matcher.Vector`, `AIInterview`. Reads config from
  `settings` and potentially System Note.

---

**8. AI Interview Plugin**

* **Purpose:** Guide note creation conversationally.
* **Decomposition:** Seems relatively cohesive.
* **Plugin Definition:**
  ```javascript
  const AIInterviewPlugin = {
      id: 'aiInterview',
      name: 'AI Interviewer',
      dependencies: ['llm', 'properties'], // Needs LLM and ability to add properties

      init(coreAPI) {
          this.coreAPI = coreAPI;
          this.llmService = coreAPI.getService('LLMService');
      },
      registerReducer: () => (state, action) => {
          // Manage state in pluginRuntimeState.aiInterview[noteId] = { isActive, messages, status }
          switch (action.type) {
              case 'AI_INTERVIEW_START': // payload: { noteId }
                  // Initialize state for noteId, set isActive=true, status='loading'
                  // Dispatch async action/middleware to send initial prompt to LLM
                  break;
              case 'AI_INTERVIEW_SEND_USER_MESSAGE': // payload: { noteId, message }
                  // Add user message to state, set status='waiting_ai'
                  // Dispatch async action/middleware to send conversation context + message to LLM
                  break;
              case 'AI_INTERVIEW_RECEIVE_AI_RESPONSE': // payload: { noteId, responseText, suggestions? }
                  // Add AI message to state, update status='idle'
                  // Store suggestions temporarily if provided by LLM response parsing
                  break;
              case 'AI_INTERVIEW_APPLY_SUGGESTION': // payload: { noteId, suggestion }
                  // Dispatch PROPERTY_ADD/UPDATE action
                  // Remove suggestion from temp storage
                  break;
              case 'AI_INTERVIEW_STOP': // payload: { noteId }
                  // Set isActive=false, maybe clear messages?
                  break;
              case 'CORE_SELECT_NOTE':
                  // Optionally stop active interview if user selects different note?
                  break;
          }
          return state;
      },
      registerUISlots: () => ({
          [SLOT_EDITOR_HEADER_ACTIONS]: (props) => {
              // Render "Start/Stop Interview" button based on runtime state for props.noteId
          },
          [SLOT_EDITOR_PLUGIN_PANELS]: (props) => {
              // Render Chat UI (messages, input) if interview is active for props.noteId
              // Render suggestions with "Apply" buttons
          }
      }),
      // Middleware/Thunks needed to handle async LLM calls and dispatch subsequent actions
  };
  ```
* **Interaction:** Uses `LLMService`. Dispatches `PROPERTY_ADD`/`UPDATE` actions handled by `PropertiesPlugin`. Manages
  its state in `pluginRuntimeState`.

---

**9. Onboarding Wizard Plugin**

* **Purpose:** Guide new users through setup.
* **Decomposition:** Seems self-contained.
* **Plugin Definition:**
  ```javascript
  const OnboardingWizardPlugin = {
      id: 'onboarding',
      name: 'Onboarding Wizard',
      // Optional dependencies on plugins it helps configure: 'nostr', 'llm'

      init(coreAPI) { this.coreAPI = coreAPI; },
      onActivate() {
           // Check if onboarding needed immediately after activation
           this._checkAndStartOnboarding();
      },
      _checkAndStartOnboarding() {
           const state = this.coreAPI.getState();
           const needsOnboarding = !state.settings.core.onboardingComplete; // Simple flag
           // More complex logic: || state.notes.length === 0 || !state.settings.plugins.nostr?.identityMethod
           if (needsOnboarding) {
               this.coreAPI.dispatch({ type: 'ONBOARDING_START' });
           }
      },
      registerReducer: () => (state, action) => {
           // Manage state in pluginRuntimeState.onboarding = { isActive, currentStep }
           // Manage completion flag in settings.core.onboardingComplete
           switch (action.type) {
               case 'ONBOARDING_START':
                   // Set isActive=true, currentStep=1
                   break;
               case 'ONBOARDING_NEXT_STEP':
                   // Increment currentStep or set isActive=false if last step
                   break;
               case 'ONBOARDING_COMPLETE':
                   // Set settings.core.onboardingComplete = true
                   // Set isActive=false
                   break;
               // Also need CORE_SET_CORE_SETTING reducer case in coreReducer to handle setting the flag
           }
           return state;
      },
      registerUISlots: () => ({
           // Render modal/overlay UI based on pluginRuntimeState.onboarding.isActive/currentStep
           // Each step might involve:
           // - Displaying info text
           // - Checking state (e.g., if Nostr configured via getPluginSettings)
           // - Dispatching actions (CORE_ADD_NOTE for system notes, CORE_SET_PLUGIN_SETTING, etc.)
           // - Providing "Next"/"Skip"/"Complete" buttons -> dispatch ONBOARDING_NEXT_STEP etc.
           [SLOT_MAIN_LAYOUT]: (props) => { // Render overlay on top of everything
               if (!props.state.pluginRuntimeState.onboarding?.isActive) return '';
               const step = props.state.pluginRuntimeState.onboarding.currentStep;
               return `<div class="onboarding-overlay">... Step ${step} UI ...</div>`;
           }
      }),
  };
  ```
* **Interaction:** Reads core and plugin settings state. Dispatches core actions (`CORE_ADD_NOTE`,
  `CORE_SET_PLUGIN_SETTING`, `CORE_SET_CORE_SETTING`) to configure the application. Manages its state in
  `pluginRuntimeState` and `settings.core`.