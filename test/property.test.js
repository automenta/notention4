import { PropertiesPlugin } from '../property.js';
import { describe, it, expect, beforeEach, vi } from 'vitest';

describe('PropertiesPlugin', () => {
    let coreAPI;
    let plugin;
    let dispatch;
    let getState;

    beforeEach(() => {
        dispatch = vi.fn();
        getState = vi.fn().mockReturnValue({
            notes: {},
            noteOrder: [],
            uiState: {},
        });
        coreAPI = {
            getService: vi.fn(),
            dispatch: dispatch,
            showGlobalStatus: vi.fn(),
            subscribe: vi.fn(),
            utils: { generateUUID: vi.fn().mockReturnValue('test-uuid'), formatDate: vi.fn() },
            getState: getState,
            getPluginAPI: vi.fn(),
        };
        plugin = { ...PropertiesPlugin };
        plugin.init(coreAPI);
    });

    it('should initialize PropertiesPlugin', () => {
        expect(plugin.id).toBe('properties');
        expect(plugin.name).toBe('Note Properties');
    });

    it('registerReducer() should return a reducer function', () => {
        const reducer = plugin.registerReducer();
        expect(typeof reducer).toBe('function');
    });

    it('registerMiddleware() should return a middleware function', () => {
        const middleware = plugin.registerMiddleware();
        expect(typeof middleware).toBe('function');
    });

    it('should add pluginData to new notes', () => {
        const reducer = plugin.registerReducer();
        const draft = { notes: { 'newNoteId': { id: 'newNoteId' } }, noteOrder: ['newNoteId'] };
        reducer(draft, { type: 'CORE_ADD_NOTE' });
        expect(draft.notes['newNoteId'].pluginData).toEqual({ properties: [] });
    });

    it('should add a property to a note', () => {
        const reducer = plugin.registerReducer();
        const draft = { notes: { 'note1': { id: 'note1', pluginData: { properties: [] } } }, noteOrder: ['note1'] };
        reducer(draft, { type: 'PROPERTY_ADD', payload: { noteId: 'note1', propertyData: { key: 'testKey', value: 'testValue' } } });
        expect(draft.notes['note1'].pluginData.properties).toEqual(expect.arrayContaining([expect.objectContaining({ key: 'testKey', value: 'testValue' })]));
    });

    it('should update a property on a note', () => {
        const reducer = plugin.registerReducer();
        const draft = {
            notes: {
                'note1': {
                    id: 'note1',
                    pluginData: { properties: [{ id: 'prop1', key: 'oldKey', value: 'oldValue' }] }
                }
            },
            noteOrder: ['note1']
        };
        reducer(draft, {
            type: 'PROPERTY_UPDATE',
            payload: { noteId: 'note1', propertyId: 'prop1', changes: { key: 'newKey', value: 'newValue' } }
        });
        expect(draft.notes['note1'].pluginData.properties[0]).toEqual(expect.objectContaining({ key: 'newKey', value: 'newValue' }));
    });

    it('should delete a property from a note', () => {
        const reducer = plugin.registerReducer();
        const draft = {
            notes: {
                'note1': {
                    id: 'note1',
                    pluginData: { properties: [{ id: 'prop1', key: 'testKey', value: 'testValue' }] }
                }
            },
            noteOrder: ['note1']
        };
        reducer(draft, { type: 'PROPERTY_DELETE', payload: { noteId: 'note1', propertyId: 'prop1' } });
        expect(draft.notes['note1'].pluginData.properties).toEqual([]);
    });

    // Add more tests for _normalizeValue, _formatDisplayValue, _validateValue, etc.
});
