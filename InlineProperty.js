import {Node} from '@tiptap/core';
import {InlinePropertyNodeView} from './InlinePropertyNodeView.js'; // We'll create this next

/**
 * Tiptap Node for representing inline properties.
 * Attributes store the necessary data.
 */
export const InlineProperty = Node.create({
    name: 'inlineProperty',
    group: 'inline',
    inline: true,
    atom: true, // Treat as a single, indivisible unit
    selectable: true,
    draggable: false,

    // Define attributes to store property data
    addAttributes() {
        return {
            propId: {
                default: null,
                parseHTML: element => element.getAttribute('data-prop-id'),
                renderHTML: attributes => ({'data-prop-id': attributes.propId}),
            },
            key: {
                default: '',
                parseHTML: element => element.getAttribute('data-key'),
                renderHTML: attributes => ({'data-key': attributes.key}),
            },
            value: {
                default: '',
                // Parse value from attribute, potentially JSON stringified for complex types?
                // For simplicity, assume string for now, NodeView will handle display/edit based on type.
                parseHTML: element => element.getAttribute('data-value'),
                renderHTML: attributes => ({'data-value': attributes.value}),
            },
            type: {
                default: 'text',
                parseHTML: element => element.getAttribute('data-type'),
                renderHTML: attributes => ({'data-type': attributes.type}),
            },
        };
    },

    // How to parse this node from HTML content
    parseHTML() {
        return [
            {
                tag: 'span[data-inline-property]', // Match spans with this attribute
            },
        ];
    },

    // How to render this node back to HTML
    renderHTML({HTMLAttributes}) {
        // The NodeView will handle the actual rendering, but this defines the basic tag structure
        return ['span', {...HTMLAttributes, 'data-inline-property': ''}, 0]; // 0 indicates no content inside the tag itself
    },

    // Use our custom NodeView
    addNodeView() {
        // The NodeView constructor will receive node, editor, getPos, decorations
        // We also need access to dispatch, ontologyService, and coreAPI passed via editor props
        return ({ node, editor, getPos, decorations }) => { // Use object destructuring for clarity
            const {dispatch, ontologyService, coreAPI} = editor.options.editorProps;
            if (!dispatch || !ontologyService || !coreAPI) {
                console.error("InlineProperty NodeView: Missing dispatch, ontologyService, or coreAPI in editor props!", editor.options.editorProps);
                // Fallback rendering
                const span = document.createElement('span');
                span.textContent = `[Error: Missing services for property ${node.attrs.key}]`;
                span.style.color = 'red';
                span.style.border = '1px solid red';
                return {dom: span};
            }
            // Pass coreAPI to the NodeView constructor
            return new InlinePropertyNodeView(node, editor.view, getPos, dispatch, ontologyService, coreAPI);
        };
    },
});
