-- Taller 2:
-- Evolucion del esquema para gestion de usuarios y productos.
--
-- Esta migracion agrega:
--   - rol y estado activo a users;
--   - soporte de soft delete;
--   - tabla products;
--   - restricciones de integridad para precio y stock.
--
-- Las migraciones V1 y V2 no se modifican para preservar la
-- repetibilidad y trazabilidad del esquema.

-- ============================================================
-- USERS
-- ============================================================

ALTER TABLE users
    ADD COLUMN role VARCHAR(20) NOT NULL DEFAULT 'USER';

ALTER TABLE users
    ADD COLUMN active BOOLEAN NOT NULL DEFAULT TRUE;

-- Solo se permiten los roles definidos por la aplicacion.
ALTER TABLE users
    ADD CONSTRAINT ck_users_role
    CHECK (role IN ('USER', 'ADMIN'));

-- failed_attempts representa el estado de bloqueo por fuerza bruta
-- y nunca debe quedar en un estado negativo.
ALTER TABLE users
    ADD CONSTRAINT ck_users_failed_attempts
    CHECK (failed_attempts >= 0);


-- ============================================================
-- PRODUCTS
-- ============================================================

CREATE TABLE products (

    id BIGSERIAL PRIMARY KEY,

    name VARCHAR(255) NOT NULL,

    price NUMERIC(12,2) NOT NULL,

    stock INT NOT NULL,

    active BOOLEAN NOT NULL DEFAULT TRUE,

    created_at TIMESTAMP NOT NULL DEFAULT now(),

    CONSTRAINT uq_products_name UNIQUE (name),

    -- Safety / sanity checking:
    -- un precio no positivo se considera un estado invalido.
    CONSTRAINT ck_products_price_positive
        CHECK (price > 0),

    -- El inventario nunca puede ser negativo.
    CONSTRAINT ck_products_stock_non_negative
        CHECK (stock >= 0)
);