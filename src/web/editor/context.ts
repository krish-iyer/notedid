import { Facet } from '@codemirror/state';

/** The path of the note being edited (for relative links and images), or null. */
export const notePathFacet = Facet.define<string | null, string | null>({
  combine: (values) => values[0] ?? null,
});

/**
 * Private mode is for the vault: nothing typed or pasted may reach the server unencrypted, so
 * link titles aren't fetched and files can't be added.
 */
export const privateModeFacet = Facet.define<boolean, boolean>({
  combine: (values) => values.some(Boolean),
});
