// Filename: nostrPlugin.js
"use strict";

// Dependencies assumed available:
// - nostrTools (from CDN v1 or later)
// - Web Crypto API (SubtleCrypto)
// - CoreAPI utilities (utils, showToast, showConfirmationDialog, saveSystemNote, getSystemNoteByType)
// - UI Slot constants

import {Utils} from "./util.js";
import {SimplePool} from 'nostr-tools/pool'
import {getPublicKey} from 'nostr-tools/pure'
import {
    SLOT_APP_STATUS_BAR,
    SLOT_EDITOR_HEADER_ACTIONS,
    SLOT_NOTE_LIST_ITEM_STATUS,
    SLOT_SETTINGS_PANEL_SECTION
} from './ui.js'; // Adjust path as needed
import "./nostr.css";

const debounce = Utils.debounce;


// --- Crypto & Utility Helper Functions ---

const NOSTR_CRYPTO_CONFIG = {
    pbkdf2: {iterations: 250000, hash: 'SHA-256', keyLengthBits: 256},
    aes: {name: 'AES-GCM', length: 256, ivLengthBytes: 12},
    saltLengthBytes: 16
};

// Base64 and Hex/Bytes conversion helpers
const encodeBase64 = (bytes) => btoa(String.fromCharCode(...bytes));
const decodeBase64 = (str) => Uint8Array.from(atob(str), c => c.charCodeAt(0));
const hexToBytes = (hex) => {
    if (hex.length % 2 !== 0) throw new Error("Invalid hex string length");
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < bytes.length; i++)
        bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
    return bytes;
};
const bytesToHex = (bytes) => bytes.reduce((str, byte) => str + byte.toString(16).padStart(2, '0'), '');

// SHA-256 Hashing using Web Crypto
async function sha256(text) {
    const encoder = new TextEncoder();
    const data = encoder.encode(text);
    const hashBuffer = await window.crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

/** Derives an AES key from a passphrase and salt using PBKDF2. */
async function deriveKey(passphrase, salt) { /* ... (Implementation unchanged) ... */
    const keyMaterial = await window.crypto.subtle.importKey('raw', new TextEncoder().encode(passphrase), {name: 'PBKDF2'}, false, ['deriveKey']);
    return window.crypto.subtle.deriveKey({
        name: 'PBKDF2',
        salt: salt,
        iterations: NOSTR_CRYPTO_CONFIG.pbkdf2.iterations,
        hash: NOSTR_CRYPTO_CONFIG.pbkdf2.hash,
    }, {name: NOSTR_CRYPTO_CONFIG.aes.name, length: NOSTR_CRYPTO_CONFIG.aes.length}, true, ['encrypt', 'decrypt']);
}

/** Encrypts data (Uint8Array) using AES-GCM. */
async function encrypt(key, iv, data) { /* ... (Implementation unchanged) ... */
    const ciphertext = await window.crypto.subtle.encrypt({name: NOSTR_CRYPTO_CONFIG.aes.name, iv: iv}, key, data);
    return new Uint8Array(ciphertext);
}

/** Decrypts ciphertext (Uint8Array) using AES-GCM. */
async function decrypt(key, iv, ciphertext) { /* ... (Implementation unchanged, includes error handling) ... */
    try {
        const decrypted = await window.crypto.subtle.decrypt({
            name: NOSTR_CRYPTO_CONFIG.aes.name,
            iv: iv
        }, key, ciphertext);
        return new Uint8Array(decrypted);
    } catch (error) {
        console.error("AES-GCM Decryption failed:", error);
        throw new Error("Decryption failed. Incorrect passphrase or corrupted data.");
    }
}

/** Generates cryptographically secure random bytes. */
function generateRandomBytes(length) { /* ... (Implementation unchanged) ... */
    return window.crypto.getRandomValues(new Uint8Array(length));
}

// Nsec/Hex Conversion Helpers (Using nostr-tools)
function nsecToHex(nsec) { /* ... (Implementation unchanged) ... */
    try {
        const {type, data} = nip19.decode(nsec);
        if (type !== 'nsec') throw new Error("Not an nsec key");
        return data;
    } catch (e) {
        console.error("Invalid nsec format:", nsec, e);
        throw new Error("Invalid nsec private key format.");
    }
}

function bytesToNsec(bytes) { /* ... (Implementation unchanged) ... */
    try {
        const hex = bytesToHex(bytes);
        return nip19.nsecEncode(hex);
    } catch (e) {
        console.error("Failed to encode nsec:", e);
        throw new Error("Failed to encode private key to nsec format.");
    }
}

// Passphrase Strength Check (Basic Example)
function checkPassphraseStrength(passphrase) {
    if (!passphrase) return {score: 0, message: 'No passphrase (insecure)'};
    let score = 0;
    if (passphrase.length >= 8) score++;
    if (passphrase.length >= 12) score++;
    if (/[a-z]/.test(passphrase)) score++;
    if (/[A-Z]/.test(passphrase)) score++;
    if (/\d/.test(passphrase)) score++;
    if (/[^a-zA-Z0-9]/.test(passphrase)) score++; // Symbol check

    let message = 'Very Weak';
    if (score >= 6) message = 'Strong';
    else if (score >= 4) message = 'Moderate';
    else if (score >= 2) message = 'Weak';

    return {score, message}; // Max score: 7
}


// --- Nostr Plugin Definition ---

export const NostrPlugin = {
    id: 'nostr',
    name: 'Nostr Network',
    dependencies: ['properties'],
    coreAPI: null,
    matcherService: null,
    _decryptedNsec: null,
    _decryptedHexPrivKey: null,
    _identityStatus: 'loading',
    _identityError: null,
    _config: {
        relays: [],
        defaultRelays: ["wss://relay.damus.io", "wss://relay.primal.net", "wss://relay.snort.social"],
        autoLockMinutes: 30, // Auto-lock after 30 minutes (0 to disable)
        eoseTimeout: 8000, // Timeout for SimplePool EOSE
    },
    _connectionStatus: 'disconnected',
    _connectionError: null,
    _relayPool: null,
    _poolSubscriptions: new Map(), // Map<subId, nostrToolsSubscription>
    _autoLockTimer: null, // Timer ID for auto-lock

    init(coreAPI) {
        this.coreAPI = coreAPI;
        this.matcherService = coreAPI.getService('MatcherService');
        this._relayPool = null;
        this._poolSubscriptions = new Map();
        this._autoLockTimer = null;

        // Reset transient state on init
        this._decryptedNsec = null;
        this._decryptedHexPrivKey = null;
        this._identityStatus = 'loading';
        this._identityError = null;
        this._connectionStatus = 'disconnected';
        this._connectionError = null;
        this._updateIdentityStatus('loading'); // Initial loading state


        this._loadConfigAndCheckIdentity();

        console.log("NostrPlugin: Initialized.");
    },

    async _loadConfigAndCheckIdentity() {
        if (typeof NostrTools === 'undefined') {
            this._updateIdentityStatus('error', {error: "Nostr library (nostr-tools) not loaded."});
            return;
        }

        this._updateIdentityStatus('loading');

        // 1. Load Relay & Plugin Config
        const settingsNote = this.coreAPI.getSystemNoteByType(`config/settings/${this.id}`);
        const propsApi = this.coreAPI.getPluginAPI('properties');
        const currentSettings = settingsNote ? (this._mapPropsToObject(propsApi?.getPropertiesForNote(settingsNote.id) || [])) : {};
        const defaultSettings = this._getDefaultSettings();

        // Load settings using the new pattern, including relays
        this._config.autoLockMinutes = currentSettings.autoLockMinutes ?? defaultSettings.autoLockMinutes ?? this._config.autoLockMinutes;
        this._config.eoseTimeout = currentSettings.eoseTimeout ?? defaultSettings.eoseTimeout ?? this._config.eoseTimeout;

        // Load relays from settings property, fallback to default
        const relaysString = currentSettings.relays ?? defaultSettings.relays ?? '';
        // Ensure relaysString is treated as a string before splitting
        const relaysList = String(relaysString).split('\n')
            .map(r => r.trim())
            .filter(r => r.startsWith('wss://') || r.startsWith('ws://')); // Allow ws:// too, but wss:// preferred
        this._config.relays = [...new Set(relaysList)]; // Ensure unique and valid format

        // Warn if no relays are configured after loading
        if (this._config.relays.length === 0) {
            console.warn("NostrPlugin: No relays configured after loading settings.");
            this.coreAPI.showGlobalStatus(
                "Nostr: No relays configured. Please add relay URLs in Nostr settings.",
                "warning",
                10000, // Show for 10 seconds
                `${this.id}-config-relays`
            );
        } else {
            this.coreAPI.clearGlobalStatus(`${this.id}-config-relays`); // Clear warning if relays are present
        }


        this.coreAPI.dispatch({
            type: 'NOSTR_CONFIG_LOADED',
            payload: {relays: this._config.relays, autoLockMinutes: this._config.autoLockMinutes}
        });

        const identityNote = this.coreAPI.getSystemNoteByType('config/nostr/identity');
        try {
            if (identityNote?.content?.encryptedNsec?.ciphertext && identityNote.content.pubkey) {
                this._identityStatus = 'locked';
                this._updateIdentityStatus('locked', {pubkey: identityNote.content.pubkey});
                console.log("NostrPlugin: Identity found, status 'locked'. PubKey:", identityNote.content.pubkey);
            } else {
                this._identityStatus = 'no_identity';
                this._updateIdentityStatus('no_identity');
                console.log("NostrPlugin: No identity found.");
            }
        } catch (error) {
            console.error("NostrPlugin: Error loading identity:", error);
            this._identityStatus = 'error';
            this._identityError = `Failed to load identity: ${error.message}`;
            this._updateIdentityStatus('error', {error: this._identityError});
        }
    },

    // --- Helpers ---
    _mapPropsToObject(properties = []) {
        const settings = {};
        properties.forEach(prop => {
            settings[prop.key] = prop.value;
        });
        return settings;
    },

    _getDefaultSettings() {
        const defaults = {};
        const ontology = this.getSettingsOntology();
        if (!ontology) return defaults;

        for (const key in ontology) {
            if (ontology[key].hasOwnProperty('default')) {
                defaults[key] = ontology[key].default;
            }
        }
        return defaults;
    },

    _clearAutoLockTimer() {
        if (this._autoLockTimer) {
            clearTimeout(this._autoLockTimer);
            this._autoLockTimer = null;
        }
    },

    _startAutoLockTimer() {
        this._clearAutoLockTimer(); // Clear any existing timer first
        const timeoutMinutes = this._config.autoLockMinutes;
        if (timeoutMinutes > 0 && this._identityStatus === 'unlocked') {
            const timeoutMs = timeoutMinutes * 60 * 1000;
            console.log(`NostrPlugin: Starting auto-lock timer for ${timeoutMinutes} minutes.`);
            this._autoLockTimer = setTimeout(() => {
                console.log(`NostrPlugin: Auto-lock timer expired. Locking identity.`);
                this.coreAPI.showToast(`Nostr identity auto-locked after ${timeoutMinutes} min.`, "info");
                this._lockOrClearIdentity(false); // false = just lock, don't clear storage
            }, timeoutMs);
        }
    },

    async _unlockIdentity(passphrase) {
        // ... (Checks for 'locked' status remain the same) ...
        const identityNote = this.coreAPI.getSystemNoteByType('config/nostr/identity');
        if (this._identityStatus !== 'locked' || !identityNote?.content?.encryptedNsec) { /* ... error handling ... */
            return false;
        }

        const {encryptedNsec, pubkey} = identityNote.content;
        let derivedKey = null;

        try {
            // ... (Key derivation, decryption, pubkey verification using nostrTools remain the same) ...
            const saltBytes = decodeBase64(encryptedNsec.salt);
            derivedKey = await deriveKey(passphrase, saltBytes);
            const ivBytes = decodeBase64(encryptedNsec.iv);
            const ciphertextBytes = decodeBase64(encryptedNsec.ciphertext);
            const decryptedPrivateKeyBytes = await decrypt(derivedKey, ivBytes, ciphertextBytes);
            const hexPrivKey = bytesToHex(decryptedPrivateKeyBytes);
            const derivedPubkey = getPublicKey(hexPrivKey);
            if (derivedPubkey !== pubkey) throw new Error("Decryption failed: Public key mismatch.");

            // --- Success ---
            this._decryptedNsec = bytesToNsec(decryptedPrivateKeyBytes);
            this._decryptedHexPrivKey = hexPrivKey;
            this._decryptedNsec = bytesToNsec(decryptedPrivateKeyBytes);
            this._decryptedHexPrivKey = hexPrivKey;
            this._identityStatus = 'unlocked';
            this._identityError = null;
            this._updateIdentityStatus('unlocked', {pubkey: pubkey}); // Dispatch state update
            this.coreAPI.showToast("Nostr identity unlocked.", "success"); // Use coreAPI directly

            this._startAutoLockTimer(); // Start auto-lock timer on successful unlock
            this.getNostrService()?.connect(); // Attempt connection after unlock
            return true;

        } catch (error) {
            // ... (Error handling remains the same) ...
            console.error("NostrPlugin: Identity unlock failed:", error);
            console.error("NostrPlugin: Identity unlock failed:", error);
            this._identityStatus = 'locked'; // Remain locked
            this._identityError = error.message.includes("Public key mismatch")
                ? "Incorrect passphrase or corrupted data."
                : `Unlock failed: ${error.message}`; // More specific error if possible
            this._decryptedHexPrivKey = null;
            this._decryptedNsec = null;
            // Dispatch error status, keeping the pubkey if available
            this._updateIdentityStatus('error', {error: this._identityError, pubkey: pubkey});
            this.coreAPI.showToast(`Unlock Error: ${this._identityError}`, "error"); // Use coreAPI directly
            return false;
        } finally {
            passphrase = null;
            derivedKey = null;
        }
    },

    async _storeIdentity(nsec, passphrase) {
        // ... (nsec format check remains the same) ...
        if (typeof nsec !== 'string' || !nsec.startsWith('nsec')) { /* ... error */
            return false;
        }

        // Passphrase Check
        const strength = checkPassphraseStrength(passphrase);
        if (strength.score < 2) { // Includes score 0 (no passphrase) and 1
            const confirmMsg = strength.score === 0
                ? "Saving without a passphrase is INSECURE. Anyone accessing browser data could use your key. Proceed?"
                : `Passphrase is VERY WEAK (${strength.message}). Strongly recommend a better one. Continue anyway?`;
            // Use coreAPI directly for confirmation dialog
            const confirmedInsecure = await this.coreAPI.utils.showConfirmationDialog({ // Assuming confirmation dialog is under utils or coreAPI directly
                title: "Security Warning", message: confirmMsg,
                confirmText: "Yes, Continue (Insecure)", cancelText: "Cancel"
            });
            if (!confirmedInsecure) return false;
        } else if (strength.score < 4) { // Weak
            this.coreAPI.showToast(`Passphrase strength: ${strength.message}. Consider using a stronger one.`, "warning", 8000); // Use coreAPI directly
        }

        let hexPrivKey = null;
        let pubkey = null;
        let derivedKey = null;

        try {
            // ... (Key generation, encryption, data prep remain the same) ...
            hexPrivKey = nsecToHex(nsec);
            pubkey = getPublicKey(hexPrivKey);
            const privateKeyBytes = hexToBytes(hexPrivKey);
            const salt = generateRandomBytes(NOSTR_CRYPTO_CONFIG.saltLengthBytes);
            const iv = generateRandomBytes(NOSTR_CRYPTO_CONFIG.aes.ivLengthBytes);
            derivedKey = await deriveKey(passphrase || "", salt);
            const ciphertext = await encrypt(derivedKey, iv, privateKeyBytes);
            const identityData = {
                version: 1,
                pubkey: pubkey,
                encryptedNsec: {
                    ciphertext: encodeBase64(ciphertext),
                    iv: encodeBase64(iv),
                    salt: encodeBase64(salt),
                    pbkdf2Iterations: NOSTR_CRYPTO_CONFIG.pbkdf2.iterations,
                    algo: `${NOSTR_CRYPTO_CONFIG.aes.name}-${NOSTR_CRYPTO_CONFIG.aes.length}`
                }
            };

            await this.coreAPI.saveSystemNote('config/nostr/identity', identityData);

            // --- Success ---
            this._decryptedNsec = nsec;
            this._decryptedHexPrivKey = hexPrivKey;
            this._decryptedNsec = nsec; // Store in memory
            this._decryptedHexPrivKey = hexPrivKey; // Store in memory
            this._identityStatus = 'unlocked';
            this._identityError = null;
            this._updateIdentityStatus('unlocked', {pubkey: pubkey}); // Dispatch state update
            this.coreAPI.showToast("Nostr identity saved and unlocked.", "success"); // Use coreAPI directly

            this._startAutoLockTimer(); // Start auto-lock timer after setup
            this.getNostrService()?.connect(); // Attempt connection after setup
            return true;
        } catch (error) {
            // ... (Error handling remains the same) ...
            console.error("NostrPlugin: Failed to store Nostr identity:", error);
            console.error("NostrPlugin: Failed to store Nostr identity:", error);
            this._identityStatus = 'error'; // Set error status
            this._identityError = `Failed to encrypt or save identity: ${error.message}`;
            this._decryptedNsec = null;
            this._decryptedHexPrivKey = null;
            this._updateIdentityStatus('error', {error: this._identityError}); // Dispatch error status
            this.coreAPI.showToast("Error: Failed to save identity.", "error"); // Use coreAPI directly
            return false;
        } finally {
            passphrase = null;
            nsec = null;
            hexPrivKey = null;
            derivedKey = null;
        }
    },

    async _lockOrClearIdentity(clearStorage = false) {
        this._clearAutoLockTimer(); // Always clear timer when locking/clearing
        this._decryptedNsec = null;
        this._decryptedHexPrivKey = null;
        this.getNostrService()?.disconnect(); // Disconnect first

        if (clearStorage) {
            try {
                // Use coreAPI directly for confirmation dialog
                const confirmed = await this.coreAPI.utils.showConfirmationDialog({ // Assuming confirmation dialog is under utils or coreAPI directly
                    title: "Confirm Clear Identity",
                    message: "Permanently remove your Nostr identity from this browser? This cannot be undone.",
                    confirmText: "Yes, Clear Identity",
                    cancelText: "Cancel"
                });
                if (!confirmed) {
                    // If cancelled, revert internal status based on whether identity *was* stored
                    const noteCheck = this.coreAPI.getSystemNoteByType('config/nostr/identity');
                    if (noteCheck?.content?.encryptedNsec) {
                        this._identityStatus = 'locked'; // Revert to locked if it existed
                        // No need to dispatch here, as no state change occurred yet
                    } else {
                        this._identityStatus = 'no_identity'; // Revert to no_identity if it didn't exist
                    }
                    return; // Stop the process
                }

                // Proceed with clearing
                await this.coreAPI.saveSystemNote('config/nostr/identity', null); // Clear note content
                this._identityStatus = 'no_identity';
                this._identityError = null;
                this._updateIdentityStatus('no_identity'); // Dispatch state update
                this.coreAPI.showToast("Nostr identity cleared from storage.", "info"); // Use coreAPI directly
            } catch (error) {
                console.error("NostrPlugin: Failed to clear identity:", error);
                this.coreAPI.showToast("Error clearing identity.", "error"); // Use coreAPI directly
                this._identityStatus = 'error'; // Set error status
                this._identityError = "Failed to clear identity.";
                this._updateIdentityStatus('error', {error: this._identityError}); // Dispatch error status
            }
        } else { // Just locking (no storage change)
            const identityNote = this.coreAPI.getSystemNoteByType('config/nostr/identity');
            if (identityNote?.content?.encryptedNsec) {
                this._identityStatus = 'locked';
                this._identityError = null;
                this._updateIdentityStatus('locked', {pubkey: identityNote.content.pubkey}); // Dispatch state update
                this.coreAPI.showToast("Nostr identity locked.", "info"); // Use coreAPI directly
            } else {
                // If trying to lock but no identity exists, ensure status is correct
                this._identityStatus = 'no_identity';
                this._identityError = null;
                this._updateIdentityStatus('no_identity'); // Dispatch state update
            }
        }
    },

    /**
     * Updates the plugin's identity status and dispatches an action to the core.
     * @param {string} status - The new identity status ('loading', 'locked', 'unlocked', 'no_identity', 'error').
     * @param {object} [options] - Optional parameters including 'pubkey' and 'error'.
     * @private
     */
    _updateIdentityStatus(status, options = {}) {
        const {pubkey, error} = options;
        this.coreAPI.dispatch({
            type: 'NOSTR_IDENTITY_STATUS_UPDATE',
            payload: status,
            pubkey: pubkey,
            error: error
        });
    },

    onActivate() {
        console.log("NostrPlugin: Activated.");
        this._startAutoLockTimer(); // Restart timer on activation if unlocked
        if (this._identityStatus === 'unlocked') {
            this.getNostrService()?.connect();
        }
    },

    getNostrService() {
        return this.coreAPI.getService('NostrService');
    },

    providesServices: () => ({
        'NostrService': {
            connect: () => {
                if (NostrPlugin._identityStatus !== 'unlocked') return console.warn("NostrService: Cannot connect, identity locked.");
                if (NostrPlugin._connectionStatus === 'connected' || NostrPlugin._connectionStatus === 'connecting') return;
                if (!NostrPlugin._config.relays || NostrPlugin._config.relays.length === 0) {
                    console.warn("NostrService: No relays configured.");
                    return;
                }

                console.log("NostrService: Connecting pool to relays:", NostrPlugin._config.relays);
                NostrPlugin._connectionStatus = 'connecting';
                NostrPlugin.coreAPI.dispatch({type: 'NOSTR_CONNECTION_STATUS_UPDATE', payload: 'connecting'});

                // Ensure pool exists, pass EOSE timeout from config
                if (!NostrPlugin._relayPool) {
                    NostrPlugin._relayPool = new SimplePool({eoseSubTimeout: NostrPlugin._config.eoseTimeout});
                }

                // Simulate connection establishment delay / success check
                setTimeout(() => {
                    if (NostrPlugin._connectionStatus === 'connecting') {
                        NostrPlugin._connectionStatus = 'connected';
                        NostrPlugin._connectionError = null;
                        NostrPlugin.coreAPI.dispatch({type: 'NOSTR_CONNECTION_STATUS_UPDATE', payload: 'connected'});
                        NostrPlugin.coreAPI.showToast("Nostr relay pool active.", "success");
                        NostrPlugin._startAutoLockTimer(); // Reset timer on successful connection interaction

                        // Fetch own profile on connect
                        const pubkey = NostrPlugin.getNostrService().getPublicKey();
                        if (pubkey) {
                            NostrPlugin.getNostrService().subscribe([{kinds: [0], authors: [pubkey], limit: 1}]);
                        }
                    }
                }, 1000);
            },

            disconnect: () => {
                NostrPlugin._clearAutoLockTimer();
                console.log("NostrService: Disconnecting pool...");
                if (NostrPlugin._relayPool) {
                    NostrPlugin._poolSubscriptions.forEach(sub => {
                        try {
                            sub.unsub()
                        } catch (e) {
                            console.warn("Error unsubscribing during disconnect:", e);
                        }
                    });
                    NostrPlugin._poolSubscriptions.clear();
                    try {
                        NostrPlugin._relayPool.close(NostrPlugin._config.relays);
                    } catch (e) {
                        console.warn("Error closing relay pool:", e);
                    }
                    NostrPlugin._relayPool = null;
                }
                if (NostrPlugin._connectionStatus !== 'disconnected') {
                    NostrPlugin._connectionStatus = 'disconnected';
                    NostrPlugin._connectionError = null;
                    NostrPlugin.coreAPI.dispatch({type: 'NOSTR_CONNECTION_STATUS_UPDATE', payload: 'disconnected'});
                    NostrPlugin.coreAPI.showToast("Disconnected from Nostr relays.", "info");
                }
            },

            signEvent: async (eventTemplate) => {
                if (NostrPlugin._identityStatus !== 'unlocked' || !NostrPlugin._decryptedHexPrivKey) throw new Error("Nostr identity locked.");
                if (!eventTemplate || typeof eventTemplate.kind !== 'number') throw new Error("Invalid event template.");
                try {
                    // Ensure nostrTools functions are available
                    if (typeof NostrTools?.finalizeEvent !== 'function') {
                         throw new Error("Nostr library function 'finalizeEvent' not available.");
                    }
                    eventTemplate.tags = eventTemplate.tags || [];
                    eventTemplate.created_at = eventTemplate.created_at || Math.floor(Date.now() / 1000);
                    // Add pubkey if missing (required by finalizeEvent)
                    if (!eventTemplate.pubkey) {
                        eventTemplate.pubkey = NostrPlugin.getNostrService().getPublicKey();
                    }
                    if (!eventTemplate.pubkey) {
                         throw new Error("Cannot sign event: Public key unavailable.");
                    }

                    const signedEvent = NostrTools.finalizeEvent(eventTemplate, NostrPlugin._decryptedHexPrivKey);
                    NostrPlugin._startAutoLockTimer(); // Reset timer on successful signing
                    return signedEvent;
                } catch (error) {
                    console.error("NostrService: Error signing:", error);
                    throw new Error(`Failed sign: ${error.message}`);
                }
            },

            publishEvent: async (eventTemplate) => {
                if (NostrPlugin._connectionStatus !== 'connected' || !NostrPlugin._relayPool) {
                    throw new Error("Cannot publish: Not connected.");
                }
                const signedEvent = await NostrPlugin.getNostrService().signEvent(eventTemplate); // Also resets timer

                console.log(`NostrService: Publishing kind ${signedEvent.kind} event:`, signedEvent.id);
                try {
                    // Ensure nostrTools SimplePool is available
                    if (!NostrPlugin._relayPool || typeof NostrPlugin._relayPool.publish !== 'function') {
                         throw new Error("Nostr relay pool is not initialized or publish function is missing.");
                    }
                    const pubs = NostrPlugin._relayPool.publish(NostrPlugin._config.relays, signedEvent);
                    // Wait for pubs, potentially log success/failure per relay later
                    const results = await Promise.allSettled(pubs);
                    console.log(`NostrService: Publish attempt finished for event ${signedEvent.id}. Results:`, results);
                    // Check if any succeeded? For now, just return the event.
                    return signedEvent;
                } catch (error) {
                    console.error("NostrService: Error publishing event:", signedEvent.id, error);
                    throw new Error(`Publish failed: ${error.message}`);
                }
            },

            subscribe: (filters) => {
                if (NostrPlugin._connectionStatus !== 'connected' || !NostrPlugin._relayPool) {
                    throw new Error("Cannot subscribe: Not connected.");
                }
                const subId = `sub_${NostrPlugin.coreAPI.utils.generateUUID()}`;
                const filtersArray = Array.isArray(filters) ? filters : [filters];
                NostrPlugin._startAutoLockTimer(); // Reset timer on interaction

                console.log(`NostrService: Subscribing [${subId}]`, filtersArray);
                try {
                    const sub = NostrPlugin._relayPool.sub(NostrPlugin._config.relays, filtersArray, {id: subId}); // Pass subId hint? nostr-tools might not use it.
                    NostrPlugin._poolSubscriptions.set(subId, sub);

                    sub.on('event', event => {
                        NostrPlugin._startAutoLockTimer(); // Reset timer on activity
                        NostrPlugin.coreAPI.dispatch({
                            type: 'NOSTR_EVENT_RECEIVED',
                            payload: {event, subscriptionId: subId}
                        });
                    });
                    sub.on('eose', (relayUrl) => {
                        NostrPlugin.coreAPI.dispatch({
                            type: 'NOSTR_EOSE_RECEIVED',
                            payload: {subscriptionId: subId, relayUrl}
                        });
                    });
                    return subId;
                } catch (error) {
                    console.error(`NostrService: Failed subscribe [${subId}]`, error);
                    throw new Error(`Subscribe failed: ${error.message}`);
                }
            },

            unsubscribe: (subId) => {
                if (!NostrPlugin._relayPool) return;
                const sub = NostrPlugin._poolSubscriptions.get(subId);
                if (sub) {
                    try {
                        sub.unsub();
                    } catch (e) {
                        console.warn("Error unsubscribing:", e);
                    }
                    NostrPlugin._poolSubscriptions.delete(subId);
                } else {
                    console.warn(`Unknown subId [${subId}]`);
                }
            },

            getPublicKey: () => {
                if (NostrPlugin._identityStatus === 'unlocked' && NostrPlugin._decryptedHexPrivKey) {
                    try {
                        return getPublicKey(NostrPlugin._decryptedHexPrivKey);
                    } catch (e) {
                        console.error("Error deriving pubkey:", e);
                    }
                }
                const note = NostrPlugin.coreAPI.getSystemNoteByType('config/nostr/identity');
                return note?.content?.pubkey || null;
            },
            isUnlocked: () => NostrPlugin._identityStatus === 'unlocked',
            getConnectionStatus: () => NostrPlugin._connectionStatus,
            getIdentityStatus: () => ({status: NostrPlugin._identityStatus, error: NostrPlugin._identityError}),
        }
    }),

    // --- Added for Enhancement #0 ---
    getSettingsOntology() {
        // Define the structure and metadata for this plugin's settings
        return {
            'autoLockMinutes': {
                type: 'number', label: 'Auto-Lock Timeout (minutes)', order: 1,
                min: 0, step: 1, default: 30,
                description: 'Automatically lock identity after minutes of inactivity (0 to disable).'
            },
            // TODO: Add relay management here instead of separate System Note?
            // 'relays': { type: 'textarea', label: 'Relay URLs', ... }
            'eoseTimeout': {
                type: 'number', label: 'Relay EOSE Timeout (ms)', order: 2,
                min: 1000, step: 500, default: 8000,
                description: 'Time to wait for End Of Stored Events marker from relays during subscription.'
            },
            'relays': {
                type: 'textarea', label: 'Relay URLs', order: 3, rows: 5,
                default: ["wss://relay.damus.io", "wss://relay.primal.net", "wss://relay.snort.social"].join('\n'),
                description: 'One wss:// URL per line. These relays will be used for connecting and publishing.'
            }
        };
    },

    // --- Reducer (Handles pluginRuntimeState) ---
    registerReducer: () => {
        const pluginId = NostrPlugin.id;
        return (draft, action) => {
            // Initialize state slice
            if (!draft.pluginRuntimeState[pluginId]) {
                draft.pluginRuntimeState[pluginId] = {
                    identityStatus: 'loading', publicKey: null, identityError: null,
                    connectionStatus: 'disconnected', connectionError: null,
                    config: {relays: [], autoLockMinutes: 30, eoseTimeout: 8000}, // Mirror relevant config
                    pendingPublish: {}, // { [noteId]: boolean }
                    activeSubscriptions: {}, // { [subId]: { filters: [], status: 'active' | 'eose_received' } }
                };
            }
            const nostrState = draft.pluginRuntimeState[pluginId];

            switch (action.type) {
                // --- Status Updates ---
                case 'NOSTR_IDENTITY_STATUS_UPDATE': /* ... (Logic unchanged) ... */
                    nostrState.identityStatus = action.payload;
                    nostrState.identityError = action.error || null;
                    if (action.payload === 'unlocked' || action.payload === 'locked') {
                        nostrState.publicKey = action.pubkey || nostrState.publicKey || null;
                    } else if (action.payload === 'no_identity') {
                        nostrState.publicKey = null;
                    }
                    if (action.payload === 'error' && action.pubkey) {
                        nostrState.publicKey = action.pubkey;
                    }
                    if (action.payload !== 'unlocked') {
                        nostrState.pendingPublish = {}; /* Clear pending on lock/clear */
                    }
                    break;
                case 'NOSTR_CONNECTION_STATUS_UPDATE':
                    nostrState.connectionStatus = action.payload;
                    nostrState.connectionError = action.error || null;
                    break;
                case 'NOSTR_CONFIG_LOADED':
                    nostrState.config.relays = action.payload.relays || [];
                    nostrState.config.autoLockMinutes = action.payload.autoLockMinutes ?? nostrState.config.autoLockMinutes;
                    break;

                // --- Request Actions (Handled by Middleware) ---
                case 'NOSTR_PUBLISH_REQUEST': /* ... (Logic unchanged) ... */
                    if (action.payload?.noteId) {
                        nostrState.pendingPublish[action.payload.noteId] = true;
                    }
                    break;
                case 'NOSTR_UNSHARE_REQUEST': // Mark as pending deletion/unshare
                    if (action.payload?.noteId) {
                        nostrState.pendingPublish[action.payload.noteId] = true;
                    } // Reuse pending flag
                    break;

                // --- Success / Failure ---
                case 'NOSTR_PUBLISH_SUCCESS':
                    if (action.payload?.noteId) {
                        delete nostrState.pendingPublish[action.payload.noteId];
                        const note = draft.notes[action.payload.noteId];
                        if (note) {
                            if (!note.pluginData) note.pluginData = {};
                            if (!note.pluginData[pluginId]) note.pluginData[pluginId] = {};
                            const pd = note.pluginData[pluginId];
                            pd.eventId = action.payload.eventId;
                            pd.publishedAt = action.payload.publishedAt;
                            pd.isShared = true;
                            pd.isDeletedOnNostr = false; // Explicitly set on successful publish
                            // Hash is calculated and added to payload by middleware
                            pd.lastSyncHash = action.payload.contentHash || null;
                        }
                    }
                    break;
                case 'NOSTR_UNSHARE_SUCCESS': // Successfully published Kind 5 for unshare
                    if (action.payload?.noteId) {
                        delete nostrState.pendingPublish[action.payload.noteId]; // Clear pending flag
                        const note = draft.notes[action.payload.noteId];
                        if (note?.pluginData?.[pluginId]) {
                            note.pluginData[pluginId].isShared = false;
                            note.pluginData[pluginId].isDeletedOnNostr = true; // Mark as deleted remotely
                            note.pluginData[pluginId].lastSyncHash = null; // Clear hash
                            // Keep eventId for reference? Optional.
                        }
                    }
                    break;
                case 'NOSTR_PUBLISH_FAILURE': /* ... (Clear pending unchanged) ... */
                    if (action.payload?.noteId) {
                        delete nostrState.pendingPublish[action.payload.noteId];
                    }
                    break;
                case 'NOSTR_UNSHARE_FAILURE': // Failed to publish Kind 5
                    if (action.payload?.noteId) {
                        delete nostrState.pendingPublish[action.payload.noteId];
                    }
                    break; // Clear pending flag


                // --- Event Handling ---
                case 'NOSTR_EVENT_RECEIVED':
                    const event = action.payload?.event;
                    if (!event) break;
                    // Handle Kind 0 (Profile) - Unchanged
                    if (event.kind === 0) { /* ... (Logic unchanged) ... */
                        try {
                            const profile = JSON.parse(event.content);
                            if (!draft.runtimeCache.nostrProfiles) draft.runtimeCache.nostrProfiles = {};
                            const existing = draft.runtimeCache.nostrProfiles[event.pubkey];
                            if (!existing || event.created_at > existing.rawEvent?.created_at) {
                                draft.runtimeCache.nostrProfiles[event.pubkey] = {
                                    ...profile,
                                    fetchedAt: Date.now(),
                                    rawEvent: event
                                };
                            }
                        } catch (e) {
                            console.warn(`NostrPlugin: Failed parse Kind 0: ${event.id}`, e);
                        }
                    }
                    // Handle Kind 5 (Deletion)
                    else if (event.kind === 5) {
                        const deletedEventIds = event.tags.filter(t => t[0] === 'e').map(t => t[1]);
                        if (deletedEventIds.length > 0) {
                            console.log(`NostrPlugin: Received deletion event ${event.id} targeting event(s): ${deletedEventIds.join(', ')}`);
                            // Find local notes matching these event IDs and mark them
                            let notesMarked = 0;
                            for (const noteId in draft.notes) {
                                const note = draft.notes[noteId];
                                const noteEventId = note?.pluginData?.[pluginId]?.eventId;
                                const notePluginData = note?.pluginData?.[pluginId];
                                if (notePluginData?.eventId && deletedEventIds.includes(notePluginData.eventId)) {
                                    if (!notePluginData.isDeletedOnNostr) {
                                        console.log(`NostrPlugin: Marking local note ${noteId} (Event ${notePluginData.eventId}) as deleted on Nostr.`);
                                        notePluginData.isDeletedOnNostr = true;
                                        notePluginData.isShared = false; // Can't be shared if deleted
                                        // Optional: Archive the local note automatically?
                                        // note.isArchived = true;
                                        notesMarked++;
                                    }
                                }
                            }
                            // Show toast outside the loop if any notes were marked
                            if (notesMarked > 0 && NostrPlugin.coreAPI) { // Check if coreAPI is available
                                NostrPlugin.coreAPI.showToast(`${notesMarked} note(s) marked as deleted on Nostr.`, "info");
                            }
                        }
                    }
                    // Add other kind handling here...
                    break;

                case 'NOSTR_EOSE_RECEIVED':
                    const {subscriptionId} = action.payload;
                    if (nostrState.activeSubscriptions[subscriptionId]) {
                        nostrState.activeSubscriptions[subscriptionId].status = 'eose_received';
                    }
                    break;

                // --- Core Event Handling ---
                case 'CORE_DELETE_NOTE': // Clear runtime state for deleted note
                    const {noteId} = action.payload;
                    delete nostrState.pendingPublish[noteId];
                    // Middleware handles publishing Kind 5
                    break;
            }
        };
    },

    // --- Middleware (Handles side effects) ---
    registerMiddleware: () => {
        const plugin = NostrPlugin;
        const pluginId = plugin.id;
        const coreAPI = plugin.coreAPI;

        return store => next => action => {
            // Reset auto-lock timer on any user interaction (dispatch)
            // Be careful not to reset on background dispatches if those occur
            if (action.type && !action.type.startsWith('NOSTR_EOSE') && !action.type.startsWith('CORE_INTERNAL')) { // Avoid resetting on EOSE or internal core ticks
                plugin._startAutoLockTimer();
            }

            // --- Handle Side Effects Triggered By Actions ---
            if (action.type === 'NOSTR_UNLOCK_REQUEST') {
                plugin._unlockIdentity(action.payload.passphrase);
            } else if (action.type === 'NOSTR_SETUP_IDENTITY_REQUEST') {
                plugin._storeIdentity(action.payload.nsec, action.payload.passphrase);
            } else if (action.type === 'NOSTR_LOCK_REQUEST') {
                plugin._lockOrClearIdentity(false);
            } else if (action.type === 'NOSTR_CLEAR_IDENTITY_REQUEST') {
                plugin._lockOrClearIdentity(true);
            } else if (action.type === 'NOSTR_CONNECT_REQUEST') {
                plugin.getNostrService()?.connect();
            } else if (action.type === 'NOSTR_DISCONNECT_REQUEST') {
                plugin.getNostrService()?.disconnect();
            } else if (action.type === 'NOSTR_PUBLISH_REQUEST') {
                // Trigger actual publish based on request
                const {noteId} = action.payload;
                const state = store.getState(); // Get current state
                const note = state.notes[noteId];
                const nostrService = plugin.getNostrService();
                if (note && nostrService?.isUnlocked() && state.pluginRuntimeState[pluginId]?.connectionStatus === 'connected') {
                    // Construct event
                    const hintRelay = plugin._config.relays.length > 0 ? plugin._config.relays[0] : '';
                    const prevEventId = note.pluginData?.[pluginId]?.eventId; // Get previous ID for edits
                    const eventTemplate = {
                        kind: 1, content: note.content, created_at: Math.floor(Date.now() / 1000),
                        tags: [...(prevEventId ? [['e', prevEventId, hintRelay, '']] : [])] // Add 'e' tag if editing
                    };
                    // Calculate hash *before* publishing
                    (async () => { // Use async IIFE to handle await for sha256
                        try {
                            const contentHash = await sha256(note.content);
                            const publishedEvent = await nostrService.publishEvent(eventTemplate);
                            store.dispatch({
                                type: 'NOSTR_PUBLISH_SUCCESS',
                                payload: {
                                    noteId,
                                    eventId: publishedEvent.id,
                                    publishedAt: publishedEvent.created_at,
                                    contentHash // Include the calculated hash
                                }
                            });
                            coreAPI.showToast(`Note "${note.name || 'Untitled'}" shared.`, "success");
                        } catch (error) {
                            console.error(`Nostr Middleware: Failed publish note ${noteId}:`, error);
                            store.dispatch({
                                type: 'NOSTR_PUBLISH_FAILURE',
                                payload: {noteId, error: error.message}
                            });
                            coreAPI.showToast(`Failed to share note: ${error.message}`, "error");
                        }
                    })();
                } else {
                    console.warn(`Nostr Middleware: Publish request for note ${noteId} skipped (not ready/unlocked/connected).`);
                    store.dispatch({
                        type: 'NOSTR_PUBLISH_FAILURE',
                        payload: {noteId, error: "Not ready/unlocked/connected"}
                    });
                }
            } else if (action.type === 'NOSTR_UNSHARE_REQUEST') { // Handle request to publish Kind 5 for unshare
                const {noteId} = action.payload;
                const state = store.getState();
                const note = state.notes[noteId];
                const nostrData = note?.pluginData?.[pluginId];
                const nostrService = plugin.getNostrService();

                if (nostrData?.isShared && nostrData.eventId && nostrService?.isUnlocked() && state.pluginRuntimeState[pluginId]?.connectionStatus === 'connected') {
                    console.log(`Nostr Middleware: Publishing deletion (Kind 5) for event ${nostrData.eventId} (Note ${noteId} - Unshare)`);
                    const deletionEventTemplate = {
                        kind: 5,
                        tags: [['e', nostrData.eventId]],
                        content: `Deleted note previously identified by event ${nostrData.eventId}`, // Standard deletion message
                        created_at: Math.floor(Date.now() / 1000),
                    };
                    nostrService.publishEvent(deletionEventTemplate)
                        .then((publishedDeletionEvent) => {
                            console.log(`Kind 5 deletion published (Event ID: ${publishedDeletionEvent.id}) for original event ${nostrData.eventId} (Unshare)`);
                            store.dispatch({
                                type: 'NOSTR_UNSHARE_SUCCESS',
                                payload: {noteId, eventId: nostrData.eventId} // Pass original event ID
                            });
                            coreAPI.showToast("Note unshared from Nostr.", "success");
                        })
                        .catch(err => {
                            // Use nostrData which is available in this scope
                            console.warn(`Failed to publish Kind 5 deletion for event ${nostrData.eventId} (Unshare): ${err.message}`);
                            store.dispatch({type: 'NOSTR_UNSHARE_FAILURE', payload: {noteId, error: err.message}});
                            coreAPI.showToast(`Failed to unshare note: ${err.message}`, "error");
                        });
                } else {
                    console.warn(`Nostr Middleware: Unshare request for note ${noteId} skipped (not shared/no eventId/not ready).`);
                    // If not shared/no eventId, just mark locally?
                    if (nostrData && !nostrData.isDeletedOnNostr) { // Check if already marked deleted
                        store.dispatch({type: 'NOSTR_UNSHARE_SUCCESS', payload: {noteId, eventId: nostrData.eventId}}); // Update local state anyway
                    } else {
                        store.dispatch({type: 'NOSTR_UNSHARE_FAILURE', payload: {noteId, error: "Cannot unshare"}}); // Clear pending state
                    }
                }
            }


            // --- Let action pass through reducers ---
            const result = next(action);
            const nextState = store.getState(); // Get state *after* action is processed

            // --- Handle Side Effects After State Update ---

            // Republish modified shared notes (Check Hash)
            if (action.type === 'CORE_UPDATE_NOTE') {
                const {noteId, changes} = action.payload;
                const note = nextState.notes[noteId]; // Note state *after* update
                const nostrData = note?.pluginData?.[pluginId];
                const nostrService = plugin.getNostrService();

                if (nostrData?.isShared && !nostrData.isDeletedOnNostr && changes.hasOwnProperty('content') && nostrService?.isUnlocked() && nextState.pluginRuntimeState[pluginId]?.connectionStatus === 'connected') {
                    // Calculate hash of *new* content
                    sha256(note.content).then(currentHash => {
                        if (currentHash !== nostrData.lastSyncHash) {
                            console.log(`Nostr Middleware: Content hash changed for shared note ${noteId}. Triggering republish.`);
                            // Dispatch publish request (which middleware will pick up on next pass)
                            store.dispatch({type: 'NOSTR_PUBLISH_REQUEST', payload: {noteId}});
                        } else {
                            // console.log(`Nostr Middleware: Content hash unchanged for note ${noteId}. No republish needed.`);
                        }
                    }).catch(hashError => {
                        console.error(`Nostr Middleware: Failed hash check for note ${noteId}:`, hashError);
                        // Maybe force republish or show error? For now, do nothing.
                    });
                }
            }
            // Handle Relay Config Updates from Settings Note
            else if (action.type === 'CORE_SYSTEM_NOTE_UPDATED' || action.type === 'PROPERTY_UPDATE') {
                const state = store.getState(); // Get current state
                const settingsNote = coreAPI.getSystemNoteByType(`config/settings/${pluginId}`);
                let noteIdToCheck = null;

                if (action.type === 'CORE_SYSTEM_NOTE_UPDATED' && action.payload.type === `config/settings/${pluginId}`) {
                    noteIdToCheck = action.payload.noteId;
                } else if (action.type === 'PROPERTY_UPDATE' && action.payload.noteId === settingsNote?.id && action.payload.changes.key === 'relays') {
                    noteIdToCheck = action.payload.noteId;
                }

                if (noteIdToCheck && noteIdToCheck === settingsNote?.id) {
                    const propsApi = coreAPI.getPluginAPI('properties');
                    const currentProperties = propsApi?.getPropertiesForNote(settingsNote.id) || [];
                    const currentSettings = plugin._mapPropsToObject(currentProperties);
                    const defaultSettings = plugin._getDefaultSettings();
                    const relaysString = currentSettings.relays ?? defaultSettings.relays ?? '';
                    const newRelaysList = [...new Set(relaysString.split('\n').map(r => r.trim()).filter(r => r.startsWith('ws')))];

                    const oldRelays = new Set(plugin._config.relays); // Compare with internal config cache
                    const changed = newRelaysList.length !== oldRelays.size || newRelaysList.some(r => !oldRelays.has(r));

                    if (changed) {
                        console.log("Nostr Middleware: Relay config changed, updating and reconnecting...");
                        plugin._config.relays = newRelaysList; // Update internal cache
                        store.dispatch({
                            type: 'NOSTR_CONFIG_LOADED',
                            payload: {relays: newRelaysList, autoLockMinutes: plugin._config.autoLockMinutes}
                        }); // Update state

                        if (plugin._connectionStatus === 'connected' && plugin._relayPool) {
                            coreAPI.showToast("Relay config updated. Reconnecting...", "info");
                            plugin.getNostrService()?.disconnect();
                            setTimeout(() => plugin.getNostrService()?.connect(), 500);
                        } else {
                            coreAPI.showToast("Nostr relay configuration updated.", "info");
                        }
                    }
                }
            }
            // Handle Deletion Event Publishing (Kind 5) when local note is deleted
            else if (action.type === 'CORE_DELETE_NOTE') {
                const {noteId, pluginDataSnapshot} = action.payload; // Use snapshot passed in payload
                const nostrDataBeforeDelete = pluginDataSnapshot?.[pluginId];
                const nostrService = plugin.getNostrService();
                // Check connection status from *nextState* because the action has already passed through reducers
                const nostrState = nextState.pluginRuntimeState?.[pluginId];

                // Check if the note *was* shared, had an event ID, and we are currently unlocked and connected
                if (nostrDataBeforeDelete?.isShared && nostrDataBeforeDelete.eventId && nostrService?.isUnlocked() && nostrState?.connectionStatus === 'connected') {
                    console.log(`Nostr Middleware: Publishing deletion (Kind 5) for event ${nostrDataBeforeDelete.eventId} (Note ${noteId} deleted locally)`);
                    const deletionEventTemplate = {
                        kind: 5,
                        tags: [['e', nostrDataBeforeDelete.eventId]],
                        content: `Deleted note previously identified by event ${nostrDataBeforeDelete.eventId}`, // Standard message
                        created_at: Math.floor(Date.now() / 1000)
                    };
                    // Publish deletion event, log success or failure
                    nostrService.publishEvent(deletionEventTemplate)
                        .then((publishedDeletionEvent) => console.log(`Kind 5 deletion published (Event ID: ${publishedDeletionEvent.id}) for original event ${nostrDataBeforeDelete.eventId}`))
                        .catch(err => console.warn(`Failed to publish Kind 5 deletion for event ${nostrDataBeforeDelete.eventId}: ${err.message}`));
                } else {
                     // console.log(`Nostr Middleware: Skipping Kind 5 publication for deleted note ${noteId} (was not shared, no eventId, or not connected/unlocked).`);
                }
            }

            return result; // Return original result from next(action)
        };
    },

    // --- UI Rendering ---
    registerUISlots: () => {
        const coreAPI = NostrPlugin.coreAPI;
        const pluginId = NostrPlugin.id;
        const plugin = NostrPlugin;

        const getNostrState = (state) => state.pluginRuntimeState?.[pluginId] || {};

        return {
            // Settings Panel
            // --- REWRITTEN for Enhancement #0 ---
            [SLOT_SETTINGS_PANEL_SECTION]: (props) => {
                const {state, dispatch, html} = props;
                const nostrState = getNostrState(state);
                const pluginId = plugin.id;
                const settingsOntology = plugin.getSettingsOntology(); // Get own schema
                const settingsNote = coreAPI.getSystemNoteByType(`config/settings/${pluginId}`);
                const propsApi = coreAPI.getPluginAPI('properties');
                const currentProperties = settingsNote ? (propsApi?.getPropertiesForNote(settingsNote.id) || []) : [];
                const currentValues = plugin._mapPropsToObject(currentProperties);
                const defaultValues = plugin._getDefaultSettings();
                const displayConfig = {...defaultValues, ...currentValues};

                const {identityStatus, publicKey, identityError} = nostrState;
                const displayPubkey = publicKey ? (NostrTools?.nip19?.npubEncode(publicKey) || `${publicKey.substring(0, 10)}...`) : 'N/A';

                // Find/Create Settings Note Button (if needed)
                let settingsNoteUI = html``;
                if (!settingsNote) {
                    settingsNoteUI = html`
                        <p>Nostr settings note not found.</p>
                        <button @click=${() => dispatch({
                            type: 'CORE_ADD_NOTE', payload: {
                                name: `${plugin.name} Settings`,
                                systemType: `config/settings/${pluginId}`,
                                content: `Stores configuration properties for the ${pluginId} plugin.`
                            }
                        })}>Create Settings Note
                        </button>
                    `;
                } else {
                    // Logic to render form fields dynamically will go here
                }

                // --- Event Handlers (Mostly unchanged, added strength check feedback) ---
                const handleSetupSubmit = (e) => {
                    e.preventDefault();
                    const f = e.target;
                    const pp = f.passphrase?.value;
                    const strength = checkPassphraseStrength(pp);
                    if (strength.score < 4) {
                        coreAPI.showToast(`Passphrase strength: ${strength.message}. Consider canceling and using a stronger one.`, strength.score < 2 ? "error" : "warning", 8000);
                    }
                    dispatch({
                        type: 'NOSTR_SETUP_IDENTITY_REQUEST',
                        payload: {nsec: f.nsec?.value?.trim(), passphrase: pp}
                    });
                    f.reset();
                };
                const handleUnlockSubmit = (e) => {
                    e.preventDefault();
                    const f = e.target;
                    dispatch({type: 'NOSTR_UNLOCK_REQUEST', payload: {passphrase: f.passphrase?.value}});
                };
                const handleLock = () => dispatch({type: 'NOSTR_LOCK_REQUEST'});
                const handleClearIdentity = () => dispatch({type: 'NOSTR_CLEAR_IDENTITY_REQUEST'});
                const handleGenerateNewKey = async () => {
                    try {
                        if (typeof NostrTools?.generatePrivateKey !== 'function') throw new Error("nostrTools func missing");
                        const sk = generatePrivateKey();
                        const nsec = nip19.nsecEncode(sk);
                        const input = document.getElementById('nostr-nsec');
                        if (input) input.value = nsec;
                        coreAPI.showToast("New key generated.", "success");
                    } catch (e) {
                        console.error("Keygen fail:", e);
                        coreAPI.showGlobalStatus(`Key generation failed: ${e.message}`, "error"); // Use showGlobalStatus
                    }
                };
                // --- Render Logic (HTML structure largely unchanged, uses displayPubkey) ---
                let identitySectionHtml;
                if (identityStatus === 'loading') {
                    identitySectionHtml = html`<p>Loading...</p>`;
                } else if (identityStatus === 'no_identity') { /* ... Setup form ... */
                    identitySectionHtml = html`<h4>Setup Nostr</h4>
                    <p class="settings-description warning">
                        <strong>Security Warning:</strong> Your 'nsec' key controls your Nostr identity.
                        <strong>Never share it. Back it up securely offline.</strong> Losing it means losing access.
                    </p>
                    <form id="nostr-setup-form" @submit=${handleSetupSubmit}>
                        <label>nsec Private Key:</label>
                        <input type="password" id="nostr-nsec" name="nsec" required placeholder="nsec1..." autocomplete="off">
                        <button type="button" @click=${handleGenerateNewKey}>Generate New Key</button>
                        <label>Passphrase (optional but recommended):</label>
                        <input type="password" id="nostr-setup-passphrase" name="passphrase" placeholder="Secure your key" autocomplete="new-password">
                        <span class="field-hint">Encrypts your key in browser storage. <strong>Saving without a passphrase is insecure.</strong></span>
                        <button type="submit">Save Identity</button>
                    </form>
                    ${identityError ? html`<p class="error">${identityError}</p>` : ''}`;
                } else if (identityStatus === 'locked') { /* ... Unlock form ... */
                    identitySectionHtml = html`<h4>Unlock Nostr</h4>
                    <p>Public Key: ${displayPubkey}</p>
                    <form id="nostr-unlock-form" @submit=${handleUnlockSubmit}><label>Enter Passphrase:</label><input
                            type="password" id="nostr-unlock-passphrase" name="passphrase" required
                            autocomplete="current-password">
                        <button type="submit">Unlock</button>
                    </form>${identityError ? html`<p class="error">${identityError}</p>` : ''}
                    <button @click=${handleClearIdentity} class="danger" style="margin-top:10px;">Clear Identity...
                    </button>`;
                } else if (identityStatus === 'unlocked') { /* ... Unlocked status ... */
                    identitySectionHtml = html`<h4>Nostr Unlocked <span style="color:var(--success-color);">🔓</span>
                    </h4><p>Public Key: ${displayPubkey}</p><p>Auto-lock:
                        ${plugin._config.autoLockMinutes > 0 ? `${plugin._config.autoLockMinutes} min` : 'Disabled'}</p>
                    <button @click=${handleLock}>Lock</button>
                    <button @click=${handleClearIdentity} class="danger" style="margin-left:10px;">Clear Identity...
                    </button>${identityError ? html`<p class="error">${identityError}</p>` : ''}`;
                } else { /* ... Error status ... */
                    identitySectionHtml = html`<h4>Nostr Error</h4><p class="error">${identityError || 'Unknown'}</p>
                    <button @click=${handleClearIdentity} class="danger" style="margin-top:10px;">Clear Identity...
                    </button>`;
                }

                return html`
                    <div class="settings-section nostr-settings">
                        <h3>${plugin.name}</h3>
                        ${identitySectionHtml}
                        <hr>
                        <h4>Plugin Configuration</h4>
                        ${settingsNoteUI}
                        ${settingsNote ? Object.keys(settingsOntology).sort((a, b) => (settingsOntology[a].order || 99) - (settingsOntology[b].order || 99)).map(key => {
                            const schema = settingsOntology[key];
                            const currentValue = displayConfig[key]; // Uses default if not set
                            const inputId = `nostr-setting-${key}`;
                            let inputElement;
                            const isRequired = schema.required;

                            // Debounced saver using PROPERTY_ADD/UPDATE
                            const saveSetting = debounce((newValue) => {
                                const existingProp = currentProperties.find(p => p.key === key);
                                let actionType = existingProp ? 'PROPERTY_UPDATE' : 'PROPERTY_ADD';
                                let payload = {};

                                if (existingProp) {
                                    if (existingProp.value === newValue) return; // No change
                                    payload = {
                                        noteId: settingsNote.id,
                                        propertyId: existingProp.id,
                                        changes: {value: newValue}
                                    };
                                } else {
                                    payload = {
                                        noteId: settingsNote.id,
                                        propertyData: {key: key, value: newValue, type: schema.type || 'text'}
                                    };
                                }
                                dispatch({type: actionType, payload: payload});
                                // TODO: Add save status indicator?
                            }, 750);

                            // Render appropriate input based on schema.type
                            switch (schema.type) {
                                case 'number':
                                    inputElement = html`<input type="number" id=${inputId} .value=${currentValue ?? ''}
                                                               ?required=${isRequired} min=${schema.min ?? ''}
                                                               max=${schema.max ?? ''} step=${schema.step ?? ''}
                                                               @input=${(e) => saveSetting(parseInt(e.target.value, 10) || (schema.default ?? 0))}>`;
                                    break;
                                case 'textarea':
                                    inputElement = html`<textarea id=${inputId} .value=${currentValue ?? ''}
                                                                  ?required=${isRequired} rows=${schema.rows || 3}
                                                                  placeholder=${schema.placeholder || ''}
                                                                  @input=${(e) => saveSetting(e.target.value)}></textarea>`;
                                    break;
                                case 'text':
                                default:
                                    inputElement = html`<input type="text" id=${inputId} .value=${currentValue ?? ''}
                                                               ?required=${isRequired}
                                                               placeholder=${schema.placeholder || ''}
                                                               @input=${(e) => saveSetting(e.target.value)}>`;
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
                        }) : ''}
                    </div>
                `;
            },

            // Status Bar (Unchanged)
            [SLOT_APP_STATUS_BAR]: (props) => { /* ... (Render logic unchanged) ... */
                const {state, dispatch, html} = props;
                const nostrState = getNostrState(state);
                const {identityStatus, connectionStatus, publicKey} = nostrState;
                const displayPubkeyShort = publicKey ? (NostrTools?.nip19?.npubEncode(publicKey)?.substring(0, 12) || `${publicKey.substring(0, 8)}`) + '...' : '';
                let statusText = 'Nostr: ';
                let statusIcon = '';
                let titleText = '';
                let action = null;
                if (identityStatus === 'unlocked') {
                    statusIcon = html`<span title="Nostr Identity Unlocked" style="color: var(--success-color); margin-right: 4px;">🔓</span>`;
                    titleText = `Nostr Unlocked (${displayPubkeyShort})`;
                    if (connectionStatus === 'connected') {
                        statusText += 'Connected';
                        titleText += ' | Relays active. Click to Disconnect.';
                        action = () => dispatch({type: 'NOSTR_DISCONNECT_REQUEST'});
                    } else if (connectionStatus === 'connecting') {
                        statusText += 'Connecting...';
                        titleText += ' | Connecting to relays...';
                    } else if (connectionStatus === 'error') {
                        statusText += 'Conn. Error';
                        titleText += ` | Connection Error: ${nostrState.connectionError || 'Unknown'}. Click to Retry.`;
                        action = () => dispatch({type: 'NOSTR_CONNECT_REQUEST'});
                    } else {
                        statusText += 'Offline';
                        titleText += ' | Disconnected. Click to Connect.';
                        action = () => dispatch({type: 'NOSTR_CONNECT_REQUEST'});
                    }
                } else if (identityStatus === 'locked') {
                    statusIcon = html`<span title="Nostr Identity Locked" style="color: var(--warning-color); margin-right: 4px;">🔒</span>`;
                    statusText += 'Locked';
                    titleText = `Nostr Locked (${displayPubkeyShort}). Click to open Settings and unlock.`;
                    action = () => coreAPI.dispatch({type: 'CORE_OPEN_MODAL', payload: {modalType: 'settings'}}); // Use modalType
                } else if (identityStatus === 'no_identity') {
                    statusIcon = html`<span title="Nostr Identity Not Setup" style="color: var(--secondary-text-color); margin-right: 4px;">⚠️</span>`;
                    statusText += 'Setup Needed';
                    titleText = 'Nostr identity not configured. Click to open Settings and set up.';
                    action = () => coreAPI.dispatch({type: 'CORE_OPEN_MODAL', payload: {modalType: 'settings'}}); // Use modalType
                } else if (identityStatus === 'error') {
                    statusIcon = html`<span title="Nostr Identity Error" style="color: var(--danger-color); margin-right: 4px;">❌</span>`;
                    statusText += 'Identity Error';
                    titleText = `Nostr Identity Error: ${nostrState.identityError || 'Unknown'}. Click to open Settings.`;
                    action = () => coreAPI.dispatch({type: 'CORE_OPEN_MODAL', payload: {modalType: 'settings'}}); // Use modalType
                } else {
                    statusText += 'Loading...';
                }
                return html`<span class="nostr-status-widget status-bar-item" title=${titleText} @click=${action}
                                  ?clickable=${!!action}>${statusIcon} ${statusText}</span>`;
            },

            // Note List Item Status (Adds indicator for remotely deleted)
            [SLOT_NOTE_LIST_ITEM_STATUS]: (props) => {
                const {state, noteId, html} = props;
                const note = state.notes[noteId];
                const nostrNoteData = note?.pluginData?.[pluginId];
                const nostrState = getNostrState(state);

                if (nostrNoteData?.isDeletedOnNostr) {
                    return html`<span class="nostr-note-status deleted"
                                      title="Deleted on Nostr (Event: ${nostrNoteData.eventId?.substring(0, 6)}...)">🗑️</span>`;
                } else if (nostrNoteData?.isShared) {
                    const isPending = nostrState.pendingPublish?.[noteId];
                    const title = isPending ? "Publishing..." : `Shared (Event: ${nostrNoteData.eventId?.substring(0, 6)}...)`;
                    const icon = isPending ? '☁️' : '🌐';
                    return html`<span class="nostr-note-status" title=${title}>${icon}</span>`;
                }
                return '';
            },

            // Editor Header Actions (Share/Unshare Button)
            [SLOT_EDITOR_HEADER_ACTIONS]: (props) => {
                const {state, noteId, dispatch, html} = props;
                const note = state.notes[noteId];
                const nostrState = getNostrState(state);
                const nostrNoteData = note?.pluginData?.[pluginId];

                if (nostrState.identityStatus !== 'unlocked') return '';

                const {isShared = false, isDeletedOnNostr = false} = nostrNoteData || {};
                // Use connectionStatus directly from nostrState
                const {pendingPublish, connectionStatus} = nostrState;
                const isPendingPublish = pendingPublish?.[noteId];
                const isConnected = connectionStatus === 'connected';

                const handleShare = () => {
                    coreAPI.showToast("Sharing note on Nostr...", "info");
                    dispatch({type: 'NOSTR_PUBLISH_REQUEST', payload: {noteId}});
                };
                const handleUnshare = () => {
                    if (confirm(`This will publish a deletion event for this note on Nostr, marking it as deleted there (but keeping it locally). Continue?`)) {
                        coreAPI.showToast("Unsharing note from Nostr...", "info");
                        dispatch({type: 'NOSTR_UNSHARE_REQUEST', payload: {noteId}});
                    }
                };

                let buttonHtml;
                if (isDeletedOnNostr) { // Use correct variable name
                    buttonHtml = html`
                        <button class="editor-header-button nostr-status-deleted" disabled
                                title="This note was marked as deleted on Nostr">🗑️ Deleted
                        </button>`;
                } else if (isShared) {
                    buttonHtml = html`
                        <button class="editor-header-button nostr-unshare-button" @click=${handleUnshare}
                                title="Publish deletion event on Nostr"
                                ?disabled=${isPendingPublish || isConnected !== 'connected'}>
                            ${isPendingPublish ? 'Working...' : '🌐 Unshare'}
                        </button>`;
                } else {
                    buttonHtml = html`
                        <button class="editor-header-button nostr-share-button" @click=${handleShare}
                                title="Share this note on Nostr"
                                ?disabled=${isPendingPublish || isConnected !== 'connected'}>
                            ${isPendingPublish ? 'Sharing...' : 'Share'}
                            ${isConnected !== 'connected' ? ' (Offline)' : ''}
                        </button>`;
                }
                return buttonHtml;
            },
        };
    },

};
