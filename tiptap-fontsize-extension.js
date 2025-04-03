
// File: ./tiptap-fontsize-extension.js
import { Extension } from '@tiptap/core'
import TextStyle from '@tiptap/extension-text-style'

export const FontSize = Extension.create({
        name: 'fontSize',

        addOptions() {
            return {
                types: ['textStyle'],
                fontSizes: ['10pt', '12pt', '14pt', '16pt', '20pt', '24pt', '32pt'], // Default sizes
            }
        },

        addGlobalAttributes() {
            return [
                {
                    types: this.options.types,
                    attributes: {
                        fontSize: {
                            default: null,
                            parseHTML: element => element.style.fontSize || null,
                            renderHTML: attributes => {
                                if (!attributes.fontSize) {
                                    return {}
                                }
                                // Ensure the value is one of the allowed sizes or handle appropriately
                                // if (!this.options.fontSizes.includes(attributes.fontSize)) {
                                //   console.warn(`FontSize: Rendering unexpected size: ${attributes.fontSize}`);
                                //   // return {}; // Optionally filter out unexpected sizes
                                // }
                                return {
                                    style: `font-size: ${attributes.fontSize}`,
                                }
                            },
                        },
                    },
                },
            ]
        },

        addCommands() {
            return {
                setFontSize: (fontSize) => ({ chain }) => {
                    // Ensure fontSize is in the allowed list or handle default/empty case
                    if (!fontSize || !this.options.fontSizes.includes(fontSize)) {
                        // If attempting to set an invalid size, consider unsetting or logging
                        // For now, let's just unset if the value isn't valid/provided
                        return chain().setMark('textStyle', { fontSize: null }).removeEmptyTextStyle().run();
                    }
                    return chain()
                        .setMark('textStyle', { fontSize })
                        .run()
                },
                unsetFontSize: () => ({ chain }) => {
                    return chain()
                        .setMark('textStyle', { fontSize: null })
                        .removeEmptyTextStyle() // Important: cleans up empty style tags
                        .run()
                },
            }
        },

        // Required dependencies
        addExtensions() {
            return [TextStyle.configure({ types: this.options.types })];
        }
    })


// NOTE: Ensure the FontSize extension code above is placed in a separate file
// named `tiptap-fontsize-extension.js` in the same directory, or adjust the import path.