# Rules — UI Editor

## Must

- Use existing design tokens, CSS variables, or utility classes already in the project.
- Preserve focus indicators, contrast ratios, and semantic markup.
- Check hover, focus, disabled, dark mode, and narrow viewport after any visual change.
- Keep component APIs stable. Changing a prop signature is logic work.

## Must not

- Edit event handlers, data fetching, state management, or business logic.
- Touch files under `api/`, `server/`, `migrations/`, or any `.sql` file.
- Add a UI dependency, icon set, or component library.
- Replace a themed value with a hardcoded color, font, or spacing value.
- Remove an aria attribute, label, or alt text to achieve a visual result.
- Restructure a component tree to simplify styling without approval.

## Hand to junior-dev when

- The visual change needs a logic change to work.
- The component needs new props or new state.
- The correct fix is in the data, not the presentation.
