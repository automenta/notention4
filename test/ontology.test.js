import { OntologyPlugin } from '../ontology.js';
import { describe, it, expect, beforeEach, vi } from 'vitest';

describe('OntologyPlugin', () => {
    let coreAPI;
    let plugin;
    let dispatch;
    let getState;

    beforeEach(() => {
        dispatch = vi.fn();
        getState = vi.fn().mockReturnValue({
            notes: {},
            systemNoteIndex: {},
        });
        coreAPI = {
            getService: vi.fn(),
            dispatch: dispatch,
            showGlobalStatus: vi.fn(),
            subscribe: vi.fn(),
            getSystemNoteByType: vi.fn(),
            getState: getState,
            publishEvent: vi.fn(),
        };
        plugin = { ...OntologyPlugin };
        plugin.init(coreAPI);
    });

    it('should initialize OntologyPlugin', () => {
        expect(plugin.id).toBe('ontology');
        expect(plugin.name).toBe('Ontology Manager');
    });

    it('providesServices() should return an OntologyService', () => {
        const services = plugin.providesServices();
        expect(services).toHaveProperty('OntologyService');
        expect(typeof services.OntologyService.getHints).toBe('function');
    });

    it('should load ontology from config note', () => {
        const configNote = { id: 'configNoteId', content: '{"hints": {"test": {}}}', updatedAt: Date.now() };
        coreAPI.getSystemNoteByType.mockReturnValue(configNote);
        plugin._loadOntology();
        expect(plugin._ontologyData).toEqual(expect.objectContaining({ hints: { test: {} } }));
    });

    it('should handle errors when parsing invalid JSON', () => {
        const configNote = { id: 'configNoteId', content: 'invalid json', updatedAt: Date.now() };
        coreAPI.getSystemNoteByType.mockReturnValue(configNote);
        plugin._loadOntology();
        expect(coreAPI.showGlobalStatus).toHaveBeenCalledWith(expect.stringContaining('Error loading ontology'), 'error', 10000);
        expect(plugin._ontologyData).toBeNull();
    });

    it('should provide default values when config note is missing properties', () => {
        const configNote = { id: 'configNoteId', content: '{}', updatedAt: Date.now() };
        coreAPI.getSystemNoteByType.mockReturnValue(configNote);
        plugin._loadOntology();
        const services = plugin.providesServices();
        expect(services.OntologyService.getHints()).toEqual({});
        expect(services.OntologyService.getTemplates()).toEqual([]);
    });

    it('should dispatch CORE_UPDATE_NOTE action when creating ontology note', () => {
        plugin._handleCreateOntologyNote(dispatch, '{"test": "data"}');
        expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({
            type: 'CORE_ADD_NOTE',
            payload: expect.objectContaining({
                systemType: 'config/ontology',
                content: expect.stringContaining('"test": "data"')
            })
        }));
    });

    // Add more tests for other methods like _handleSaveOntology, getUIHints, inferType, etc.
});
