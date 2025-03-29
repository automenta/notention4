# Notention.js (Plugin version)

https://aistudio.google.com/app/prompts/1V8RrP2Ho9qKT3AMgkTo6Wrvfo3KYrFc_

Design specifications (A,B,C,D,E):
https://gist.github.com/automenta/b5696d69bc6213d41e1915a106e38921#file-comparison-md

====

# Spec (see spec.md)

Synthesize a hybrid final specification from these versions.

Write in Javascript-flavored psuedocode, in preparation for implementing the core (and its plugin interfaces) - but NOT
any of the plugins themselves.

The core, when implemented, should be completely functional as a TODO/notebook app, ready to be extended with any or all
of the plugins, when they are developed.

Focus on function, rather than form (CSS).

Include as much implementation detail as possible.

====

# Plugins (see plugins.md)

For each plugin: create a psuedocode summary.

Note the integration points, and how the plugins interact through them.

Consider decomposing into smaller, more granular, more modular plugins - and how they combine to implement the complete
specified feature.

====

# Implement the complete Core in JavaScript as one HTML file.

- Feature-complete: notebook / TODO-list app + core specified functionality
- Runs out-of-the-box without error
- Ready for plugins, as they are developed, growing into the complete app iteratively and organically
- Do not implement any Plugin

## Code Guidelines

- **Clarity:** Write clear, self-documenting code.
- **Modern:** Use the latest language features and APIs.
- **Compact:** Write consolidated, compact code that doesn't waste tokens.
- **DRY (Don't Repeat Yourself):** Deduplicate and unify redundant declarations.
- **Ontology Driven:** Maximally leverage Ontology semantics to drive application functionality (elegant dogfooding).
- **Comments:** Tersely, but completely, explain complex logic or design decisions. Avoid obvious, unhelpful, or
  formatting-only comments.

## UI Design Principles

- **Progressive Disclosure:** Hide complexity until it's needed for a clean and intuitive UI.
- **Consistency and Familiarity:** Use established UI patterns and common icons for ease of learning and use.
- **Visual Hierarchy:** Use whitespace, font sizes, and visual cues to guide the user's eye and create a clear
  structure.
- **Minimize Cognitive Load:** Reduce clutter, simplify interactions, and provide clear feedback for a fluent user
  experience.

====

for f in *; do echo -e "# $f\n\`\`\`\n$(cat "$f")\n\`\`\`\n" >> output.md; done

====

# Compare the implementations of this app, {A,B,C,D,E,F,G}.html, choosing the best features for a hybrid synthesis revision.

* The app specification (spec.md) provides an overview of the application and its purpose.
* Consider the plugin specifications (plugins.md), and how to best support their features and implementation.
* Consider code quality, clarity, modularity and abstraction, flexibility, boilerplate/redundancy, and any other details
  that could affect the development process and the resulting implementation
* Explore improvements that can be applied in a revision.

====

Write a complete revision plan, that, when combined with {A,B,C,D,E,F,G}.html, produces a more ideal version.

Identify and include helpful and reliable dependencies, like Immer.js, to provide mature functionality that reduces
necessary code.

Identify ways to deduplicate redundancy and avoid boilerplate without affecting functionality, perhaps by introducing
utility functions and classes.