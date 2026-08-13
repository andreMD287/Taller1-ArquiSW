-- Fase 1: sesiones sin estado con JWT. El token de acceso ya no se persiste
-- (se verifica su firma en memoria, ver TokenService); la tabla "sessions"
-- era la que ponia a Postgres en el camino critico del 95% de las peticiones
-- (validate) y desaparece. Solo el refresh token -opaco, de vida larga y de
-- bajo volumen (5% del trafico)- se sigue persistiendo, porque es la unica
-- pieza que necesita sobrevivir un reinicio y ser revocable en /logout.

DROP TABLE IF EXISTS sessions;

CREATE TABLE refresh_tokens (
    id BIGSERIAL PRIMARY KEY,
    token VARCHAR(64) NOT NULL,
    user_id BIGINT NOT NULL REFERENCES users(id),
    username VARCHAR(50) NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT now(),
    expires_at TIMESTAMP NOT NULL,
    CONSTRAINT uq_refresh_tokens_token UNIQUE (token)
);

-- La tarea @Scheduled de purga filtra por expires_at: sin este indice el
-- barrido degrada de O(log n) a O(n) a medida que crecen los refresh tokens.
CREATE INDEX idx_refresh_tokens_expires_at ON refresh_tokens (expires_at);
