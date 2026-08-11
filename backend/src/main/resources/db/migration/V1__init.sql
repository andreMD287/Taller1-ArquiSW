-- Esquema inicial del tier de datos: usuarios y sesiones.
-- Migracion versionada (Flyway) para que el esquema viaje con el codigo y no
-- dependa de pasos manuales al desplegar (Cap. 5: repeatability).

CREATE TABLE users (
    id BIGSERIAL PRIMARY KEY,
    username VARCHAR(50) NOT NULL,
    password_hash VARCHAR(100) NOT NULL,
    failed_attempts INT NOT NULL DEFAULT 0,
    locked_until TIMESTAMP NULL,
    created_at TIMESTAMP NOT NULL DEFAULT now(),
    CONSTRAINT uq_users_username UNIQUE (username)
);

CREATE TABLE sessions (
    id BIGSERIAL PRIMARY KEY,
    token VARCHAR(64) NOT NULL,
    user_id BIGINT NOT NULL REFERENCES users(id),
    username VARCHAR(50) NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT now(),
    expires_at TIMESTAMP NOT NULL,
    CONSTRAINT uq_sessions_token UNIQUE (token)
);

-- La tarea @Scheduled de purga filtra por expires_at constantemente: sin este
-- indice el barrido degrada de O(log n) a O(n) a medida que crecen las sesiones,
-- justo la falta latente que el taller pide anticipar.
CREATE INDEX idx_sessions_expires_at ON sessions (expires_at);
