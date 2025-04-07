import { RichTextEditorPlugin } from '../editor.js';
import { describe, it, expect, beforeEach, vi } from 'vitest';

describe('RichTextEditorPlugin', () => {
    let coreAPI;
    let plugin;

    beforeEach(() => {
        coreAPI = {
            getService: vi.fn(),
            dispatch: vi.fn(),
            showGlobalStatus: vi.fn(),
            getState: vi.fn().mockReturnValue({}),
        };
        plugin = { ...RichTextEditorPlugin }; // Create a copy to avoid modifying the original
        plugin.init(coreAPI);
    });

    it('should initialize RichTextEditorPlugin', () => {
        expect(plugin.id).toBe('richTextEditor');
        expect(plugin.name).toBe('Rich Text Editor (Tiptap)');
    });

    it('providesServices() should return an EditorService', () => {
        const services = plugin.providesServices();
        expect(services).toHaveProperty('EditorService');
        expect(typeof services.EditorService.getContent).toBe('function');
    });

    // Add more tests for EditorService methods (getContent, setContent, etc.)
    // These tests will require mocking the internal _editorInstance and its methods
    // For example:
    it('EditorService.getContent() should return content from editor instance', () => {
        const mockEditorInstance = {
            getContent: vi.fn().mockReturnValue('Test Content'),
            inactive: vi.fn().mockReturnValue(false),
        };
        plugin._editorInstance = mockEditorInstance;
        const services = plugin.providesServices();
        const content = services.EditorService.getContent();
        expect(mockEditorInstance.getContent).toHaveBeenCalled();
        expect(content).toBe('Test Content');
    });

    it('registerMiddleware() should return a middleware function', () => {
        const middleware = plugin.registerMiddleware();
        expect(typeof middleware).toBe('function');
    });

    // Add tests for _insertTemplateContent, _handleInsertTemplate, etc.
    // These tests will require mocking coreAPI, editorService, and ontologyService
});
