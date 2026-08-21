-- Optimiza la busqueda parcial case-insensitive por nombre de producto.
--
-- ProductRepository realiza:
--     lower(name) LIKE '%texto%'
--
-- Un indice B-tree convencional no es adecuado para patrones cuyo
-- wildcard aparece al inicio. pg_trgm permite indexar similitud/subcadenas
-- y GIN reduce el costo de estas busquedas a medida que aumenta el volumen.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX idx_products_name_trgm
    ON products
    USING GIN (lower(name) gin_trgm_ops);