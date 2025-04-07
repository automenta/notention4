import { StateManager, PersistenceService, PluginManager, CoreAPI } from '../core.js'; // Adjust path if necessary
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'; // Using vi for spies/mocks
import localforage from 'localforage'; // Import localforage for PersistenceService tests

// Mock localforage for testing PersistenceService in Node environment
vi.mock('localforage', () => {
    const storage = {};
    return {
        default: {
            config: vi.fn(),
            getItem: vi.fn(key => Promise.resolve(storage[key] || null)),
            setItem: vi.fn((key, value) => { storage[key] = value; return Promise.resolve(); }),
            removeItem: vi.fn(key => { delete storage[key]; return Promise.resolve(); }),
            clear: vi.fn(() => { Object.keys(storage).forEach(key => delete storage[key]); return Promise.resolve(); }),
        }
    };
});


describe('StateManager', () => {
    // ... (Existing StateManager tests from previous version - keep these) ...
    let stateManager;
    let initialState;
    let coreReducer;

    beforeEach(() => {
        initialState = { count: 0 };
        coreReducer = (state = initialState, action) => {
            switch (action.type) {
                case 'INCREMENT':
                    return { ...state, count: state.count + 1 };
                case 'DECREMENT':
                    return { ...state, count: state.count - 1 };
                default:
                    return state;
            }
        };
        stateManager = new StateManager(initialState, coreReducer);
    });

    it('should initialize with the correct initial state', () => {
        expect(stateManager.getState()).toEqual(initialState);
    });

    it('getState() should return the current state', () => {
        expect(stateManager.getState()).toEqual({ count: 0 });
        stateManager.dispatch({ type: 'INCREMENT' });
        expect(stateManager.getState()).toEqual({ count: 1 });
    });

    it('dispatch() should update state using coreReducer', () => {
        stateManager.dispatch({ type: 'INCREMENT' });
        expect(stateManager.getState().count).toBe(1);
        stateManager.dispatch({ type: 'DECREMENT' });
        expect(stateManager.getState().count).toBe(0);
    });

    it('dispatch() should log an error for invalid actions', () => {
        const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {}); // Spy on console.error and prevent actual logging
        stateManager.dispatch({}); // Missing type
        expect(consoleErrorSpy).toHaveBeenCalled();
        stateManager.dispatch({ type: 123 }); // type is not a string
        expect(consoleErrorSpy).toHaveBeenCalledTimes(2);
        consoleErrorSpy.mockRestore(); // Restore original console.error
    });

    it('registerReducer() should register a plugin reducer and update state', () => {
        const pluginReducer = (state = {}, action) => {
            switch (action.type) {
                case 'PLUGIN_ACTION':
                    return { ...state, pluginData: { value: action.payload } };
                default:
                    return state;
            }
        };
        stateManager.registerReducer('testPlugin', pluginReducer);
        stateManager.dispatch({ type: 'PLUGIN_ACTION', payload: 'test' });
        expect(stateManager.getState().pluginData).toEqual({ value: 'test' });
    });
});


describe('PersistenceService', () => {
    let stateManager;
    let persistenceService;
    let initialState;
    let coreReducer;

    beforeEach(() => {
        initialState = { notes: {}, noteOrder: [], settings: { core: { theme: 'light' } } };
        coreReducer = (state = initialState, action) => {
            switch (action.type) {
                case 'CORE_SET_CORE_SETTING':
                    return { ...state, settings: { core: { ...state.settings.core, [action.payload.key]: action.payload.value } } };
                case 'CORE_STATE_LOADED':
                    return action.payload.loadedState || state;
                default:
                    return state;
            }
        };
        stateManager = new StateManager(initialState, coreReducer);
        persistenceService = new PersistenceService(stateManager);
    });

    afterEach(async () => {
        await localforage.clear(); // Clear localforage after each test
        vi.clearAllMocks(); // Clear mocks to reset call counts
    });

    it('should initialize PersistenceService', () => {
        expect(persistenceService).toBeInstanceOf(PersistenceService);
    });

    it('loadState() should load state from localforage', async () => {
        const savedState = { settings: { core: { theme: 'dark' } } };
        localforage.setItem.mockResolvedValueOnce(savedState); // Mock setItem to resolve immediately
        localforage.getItem.mockResolvedValueOnce(savedState); // Mock getItem to return savedState

        const loadedState = await persistenceService.loadState();
        expect(loadedState).toEqual(savedState);
        expect(localforage.getItem).toHaveBeenCalledWith('realityNotebookAppState_v10.1_core');
    });

    it('loadState() should return null if no saved state found', async () => {
        localforage.getItem.mockResolvedValueOnce(null); // Mock getItem to return null

        const loadedState = await persistenceService.loadState();
        expect(loadedState).toBeNull();
    });

    it('saveState() should save state to localforage', async () => {
        const stateToSave = { notes: { 'note1': { id: 'note1', name: 'Test Note' } }, noteOrder: ['note1'], settings: { core: { theme: 'light' } } };
        await persistenceService.saveState(stateToSave);
        expect(localforage.setItem).toHaveBeenCalledWith('realityNotebookAppState_v10.1_core', stateToSave);
    });

    it('filterStateForSaving() should remove uiState and pluginRuntimeState', () => {
        const fullState = {
            ...initialState,
            uiState: { selectedNoteId: 'note1' },
            pluginRuntimeState: { pluginA: { data: 'test' } },
            otherData: 'keep'
        };
        const filteredState = persistenceService.filterStateForSaving(fullState);
        expect(filteredState.uiState).toBeUndefined();
        expect(filteredState.pluginRuntimeState).toBeUndefined();
        expect(filteredState.otherData).toBe('keep');
    });

    it('clearState() should clear state from localforage and dispatch CORE_STATE_CLEARED', async () => {
        const dispatchSpy = vi.spyOn(stateManager, 'dispatch');
        await persistenceService.clearState();
        expect(localforage.removeItem).toHaveBeenCalledWith('realityNotebookAppState_v10.1_core');
        expect(dispatchSpy).toHaveBeenCalledWith({ type: 'CORE_STATE_CLEARED' });
    });
});


describe('PluginManager', () => {
    let stateManager;
    let uiRenderer;
    let eventBus;
    let pluginManager;
    let coreAPI;

    beforeEach(() => {
        stateManager = new StateManager({}, () => {}); // Mock StateManager
        uiRenderer = { registerSlotComponent: vi.fn() }; // Mock UIRenderer
        eventBus = { publish: vi.fn(), subscribe: vi.fn() }; // Mock EventBus
        pluginManager = new PluginManager(stateManager, uiRenderer, eventBus);
        coreAPI = pluginManager._coreAPI;
    });

    it('should initialize PluginManager', () => {
        expect(pluginManager).toBeInstanceOf(PluginManager);
    });

    it('registerPlugin() should register a plugin definition', () => {
        const pluginDef = { id: 'testPlugin', name: 'Test Plugin', init: vi.fn() };
        pluginManager.registerPlugin(pluginDef);
        expect(pluginManager._pluginRegistry.has('testPlugin')).toBe(true);
        const registeredPlugin = pluginManager._pluginRegistry.get('testPlugin');
        expect(registeredPlugin.definition).toBe(pluginDef);
        expect(registeredPlugin.status).toBe('registered');
    });

    it('activatePlugins() should activate registered plugins in correct order', () => {
        const pluginDef1 = { id: 'pluginA', name: 'Plugin A', init: vi.fn(), dependencies: ['pluginB'] };
        const pluginDef2 = { id: 'pluginB', name: 'Plugin B', init: vi.fn() };
        pluginManager.registerPlugin(pluginDef1);
        pluginManager.registerPlugin(pluginDef2);
        pluginManager.activatePlugins();
        expect(pluginDef2.init).toHaveBeenCalledBefore(pluginDef1.init); // PluginB (no deps) should init before PluginA (dep on B)
        expect(pluginManager._pluginRegistry.get('pluginA').status).toBe('active');
        expect(pluginManager._pluginRegistry.get('pluginB').status).toBe('active');
    });

    it('activatePlugins() should handle plugin activation failure and set status to error', () => {
        const pluginDefWithError = { id: 'errorPlugin', name: 'Error Plugin', init: () => { throw new Error('Init error'); } };
        pluginManager.registerPlugin(pluginDefWithError);
        pluginManager.activatePlugins();
        expect(pluginManager._pluginRegistry.get('errorPlugin').status).toBe('error');
        expect(pluginManager._pluginRegistry.get('errorPlugin').error).toBeInstanceOf(Error);
    });

    it('registerService() should register a service', () => {
        const serviceInstance = { testMethod: vi.fn() };
        pluginManager.registerService('testPlugin', 'TestService', serviceInstance);
        expect(pluginManager._services.has('TestService')).toBe(true);
        expect(pluginManager.getService('TestService')).toBe(serviceInstance);
    });

    it('getService() should return registered service instance', () => {
        const serviceInstance = { testMethod: vi.fn() };
        pluginManager.registerService('testPlugin', 'TestService', serviceInstance);
        const retrievedService = pluginManager.getService('TestService');
        expect(retrievedService).toBe(serviceInstance);
    });

    it('getService() should return null if service not registered', () => {
        expect(pluginManager.getService('NonExistentService')).toBeNull();
    });

    it('getPluginAPI() should return plugin API if plugin is active', () => {
        const pluginAPI = { apiMethod: vi.fn() };
        const pluginDef = { id: 'apiPlugin', name: 'API Plugin', init: vi.fn(), getAPI: () => pluginAPI };
        pluginManager.registerPlugin(pluginDef);
        pluginManager.activatePlugins();
        expect(pluginManager.getPluginAPI('apiPlugin')).toBe(pluginAPI);
    });

    it('getPluginAPI() should return null if plugin is not active or not found', () => {
        expect(pluginManager.getPluginAPI('nonActivePlugin')).toBeNull(); // Not registered
        pluginManager.registerPlugin({ id: 'inactivePlugin', name: 'Inactive Plugin', init: vi.fn() });
        expect(pluginManager.getPluginAPI('inactivePlugin')).toBeNull(); // Registered but not activated
    });
});


describe('CoreAPI', () => {
    let stateManager;
    let pluginManager;
    let uiRenderer;
    let eventBus;
    let coreAPI;

    beforeEach(() => {
        stateManager = new StateManager({}, () => {}); // Mock StateManager
        pluginManager = new PluginManager(stateManager, {}, {}); // Mock PluginManager (no UI/Event needed for CoreAPI tests)
        uiRenderer = {}; // Mock UIRenderer
        eventBus = { publish: vi.fn(), subscribe: vi.fn() }; // Mock EventBus
        coreAPI = new CoreAPI(stateManager, pluginManager, uiRenderer, eventBus);
    });

    it('should initialize CoreAPI', () => {
        expect(coreAPI).toBeInstanceOf(CoreAPI);
    });

    it('dispatch() should call stateManager.dispatch', () => {
        const dispatchSpy = vi.spyOn(stateManager, 'dispatch');
        const action = { type: 'TEST_ACTION' };
        coreAPI.dispatch(action);
        expect(dispatchSpy).toHaveBeenCalledWith(action);
    });

    it('getState() should call stateManager.getState', () => {
        const getStateSpy = vi.spyOn(stateManager, 'getState');
        coreAPI.getState();
        expect(getStateSpy).toHaveBeenCalled();
    });

    it('subscribe() should call stateManager.subscribe', () => {
        const subscribeSpy = vi.spyOn(stateManager, 'subscribe');
        const listener = () => {};
        coreAPI.subscribe(listener);
        expect(subscribeSpy).toHaveBeenCalledWith(listener);
    });

    it('getService() should call pluginManager.getService', () => {
        const getServiceSpy = vi.spyOn(pluginManager, 'getService');
        coreAPI.getService('TestService');
        expect(getServiceSpy).toHaveBeenCalledWith('TestService');
    });

    it('getPluginAPI() should call pluginManager.getPluginAPI', () => {
        const getPluginAPISpy = vi.spyOn(pluginManager, 'getPluginAPI');
        coreAPI.getPluginAPI('TestPlugin');
        expect(getPluginAPISpy).toHaveBeenCalledWith('TestPlugin');
    });

    it('showGlobalStatus() should dispatch CORE_SET_GLOBAL_STATUS action', () => {
        const dispatchSpy = vi.spyOn(stateManager, 'dispatch');
        coreAPI.showGlobalStatus('Test Message', 'info', 3000);
        expect(dispatchSpy).toHaveBeenCalledWith({
            type: 'CORE_SET_GLOBAL_STATUS',
            payload: { message: 'Test Message', type: 'info', duration: 3000, id: null }
        });
    });

    it('clearGlobalStatus() should dispatch CORE_CLEAR_GLOBAL_STATUS action', () => {
        const dispatchSpy = vi.spyOn(stateManager, 'dispatch');
        coreAPI.clearGlobalStatus();
        expect(dispatchSpy).toHaveBeenCalledWith({ type: 'CORE_CLEAR_GLOBAL_STATUS', payload: { id: null } });
    });

    it('publishEvent() should call eventBus.publish', () => {
        const publishSpy = vi.spyOn(eventBus, 'publish');
        const eventType = 'TEST_EVENT';
        const payload = { data: 'test' };
        coreAPI.publishEvent(eventType, payload);
        expect(publishSpy).toHaveBeenCalledWith(eventType, payload);
    });

    it('subscribeToEvent() should call eventBus.subscribe', () => {
        const subscribeSpy = vi.spyOn(eventBus, 'subscribe');
        const eventType = 'TEST_EVENT';
        const handler = () => {};
        coreAPI.subscribeToEvent(eventType, handler);
        expect(subscribeSpy).toHaveBeenCalledWith(eventType, handler);
    });
});
