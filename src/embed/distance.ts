/**
 * Distance‑operator, opclass, index method and index name for pgvector ANN queries
 *
 * Operator is cosine distance (`<=>`), opclass is `vector_cosine_ops`
 * Index is HNSW, the name follows the `chunks_embedding` column convention
 *
 * These values are referenced both in migration‑generated SQL and in TypeScript
 * queries that use raw operators or index hints
 */

export const VECTOR_DISTANCE_OPERATOR = '<=>';

export const VECTOR_OPS = 'vector_cosine_ops';

export const VECTOR_INDEX_METHOD = 'hnsw';

export const VECTOR_INDEX_NAME = 'chunks_embedding_ann';
