-- Bootstrap del primer administrador del sistema.
--
-- ADR-010:
-- El sistema necesita un ADMIN inicial para permitir la administracion
-- posterior de usuarios y roles.
--
-- La contraseña nunca se almacena en texto plano. La migracion contiene
-- exclusivamente un hash BCrypt generado con BCryptPasswordEncoder.
--
-- Si ya existe un ADMIN activo, no se crea uno adicional.

INSERT INTO users (
    username,
    password_hash,
    role,
    active,
    failed_attempts,
    created_at
)
SELECT
    'admin',
    '$2a$10$OyPloBJ4Xn2q0dfxgWhE9O1AyMJjuHZZe7HjVlep5oPoKa3uEa8FG',
    'ADMIN',
    TRUE,
    0,
    now()
WHERE NOT EXISTS (
    SELECT 1
    FROM users
    WHERE role = 'ADMIN'
      AND active = TRUE
);