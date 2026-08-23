$ErrorActionPreference = "Stop"

$baseUrl = "http://localhost:8080"

function Assert-Equal {
    param(
        $Expected,
        $Actual,
        $Message
    )

    if ($Expected -ne $Actual) {
        throw "FAIL: $Message. Esperado=$Expected Actual=$Actual"
    }

    Write-Host "PASS: $Message"
}

function Get-StatusCode {
    param(
        [scriptblock]$Action
    )

    try {
        & $Action | Out-Null
        return 200
    }
    catch {
        return [int]$_.Exception.Response.StatusCode
    }
}

Write-Host ""
Write-Host "=== API E2E TESTS ==="
Write-Host ""

# ---------------------------------------------------
# 1. Health
# ---------------------------------------------------

$health = Invoke-RestMethod `
    -Uri "$baseUrl/actuator/health/liveness" `
    -Method Get

Assert-Equal "UP" $health.status "Liveness"

$readiness = Invoke-RestMethod `
    -Uri "$baseUrl/actuator/health/readiness" `
    -Method Get

Assert-Equal "UP" $readiness.status "Readiness"

# ---------------------------------------------------
# 2. Crear usuario único
# ---------------------------------------------------

$username = "qatest" + (Get-Date -Format "HHmmssfff")
$password = "QaPassword123!"

$registerBody = @{
    username = $username
    password = $password
} | ConvertTo-Json

$registered = Invoke-RestMethod `
    -Uri "$baseUrl/api/auth/register" `
    -Method Post `
    -ContentType "application/json" `
    -Body $registerBody

Assert-Equal $username $registered.username "Registro de usuario"

# ---------------------------------------------------
# 3. Login
# ---------------------------------------------------

$loginBody = @{
    username = $username
    password = $password
} | ConvertTo-Json

$login = Invoke-RestMethod `
    -Uri "$baseUrl/api/auth/login" `
    -Method Post `
    -ContentType "application/json" `
    -Body $loginBody

if ([string]::IsNullOrWhiteSpace($login.accessToken)) {
    throw "FAIL: Login no devolvió accessToken"
}

Write-Host "PASS: Login genera access token"

$token = $login.accessToken

$headers = @{
    Authorization = "Bearer $token"
}

# ---------------------------------------------------
# 4. Obtener ID desde JWT
# ---------------------------------------------------

$payload = $token.Split('.')[1]

switch ($payload.Length % 4) {
    2 { $payload += "==" }
    3 { $payload += "=" }
}

$payload = $payload.Replace('-', '+').Replace('_', '/')

$jwtData = [System.Text.Encoding]::UTF8.GetString(
    [Convert]::FromBase64String($payload)
) | ConvertFrom-Json

$userId = [long]$jwtData.sub

Write-Host "PASS: JWT contiene userId=$userId"

# ---------------------------------------------------
# 5. Usuario accede a sí mismo
# ---------------------------------------------------

$self = Invoke-RestMethod `
    -Uri "$baseUrl/api/users/$userId" `
    -Method Get `
    -Headers $headers

Assert-Equal $username $self.username "USER accede a su propio recurso"

# ---------------------------------------------------
# 6. USER no puede listar usuarios
# ---------------------------------------------------

$status = Get-StatusCode {
    Invoke-RestMethod `
        -Uri "$baseUrl/api/users" `
        -Method Get `
        -Headers $headers
}

Assert-Equal 403 $status "USER no puede listar todos los usuarios"

# ---------------------------------------------------
# 7. Sin autenticación
# ---------------------------------------------------

$status = Get-StatusCode {
    Invoke-RestMethod `
        -Uri "$baseUrl/api/users/$userId" `
        -Method Get
}

Assert-Equal 401 $status "Endpoint protegido rechaza petición sin JWT"

# ---------------------------------------------------
# 8. Actualizar username propio
# ---------------------------------------------------

$newUsername = "qaupdated" + (Get-Date -Format "HHmmssfff")

$updateBody = @{
    username = $newUsername
} | ConvertTo-Json

$updated = Invoke-RestMethod `
    -Uri "$baseUrl/api/users/$userId" `
    -Method Put `
    -Headers $headers `
    -ContentType "application/json" `
    -Body $updateBody

Assert-Equal $newUsername $updated.username "Actualización de usuario"

# ---------------------------------------------------
# 9. Comprobar persistencia
# ---------------------------------------------------

$persisted = Invoke-RestMethod `
    -Uri "$baseUrl/api/users/$userId" `
    -Method Get `
    -Headers $headers

Assert-Equal $newUsername $persisted.username "Cambio persistido en base de datos"

Write-Host ""
Write-Host "===================================="
Write-Host "API E2E: ALL TESTS PASSED"
Write-Host "===================================="