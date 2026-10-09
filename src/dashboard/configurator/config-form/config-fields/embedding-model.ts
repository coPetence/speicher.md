/**
 * The model name of a semantic retrieval endpoint
 *
 * Entering a name makes the browser ask the server for the width of the vectors
 * that model returns, and writes the answer into the Dimensions field while that
 * is empty or still holds an answer written this way. See `embedding-width-lookup.ts`
 */

import type { TextBox, TextBoxOptions } from './text';
import { textBox } from './text';

export interface EmbeddingModelField extends TextBox {
  kind: 'embedding-model';
  // Path of the Dimensions field the measured vector width is written into
  dimensionsPath: string;
}

export interface EmbeddingModelOptions extends TextBoxOptions {
  dimensionsPath: string;
}

export function embeddingModelField(
  root: unknown,
  path: (string | number)[],
  schemaPath: string,
  label: string,
  options: EmbeddingModelOptions,
): EmbeddingModelField {
  return {
    ...textBox(root, path, schemaPath, label, options),
    kind: 'embedding-model',
    dimensionsPath: options.dimensionsPath,
  };
}
