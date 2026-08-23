import http from 'k6/http';
import { check, sleep } from 'k6';
import encoding from 'k6/encoding';

const BASE_URL = __ENV.BASE_URL || 'http://host.docker.internal:8080';

export const options = {
    vus: 10,
    duration: '30s',

    thresholds: {
        http_req_duration: ['p(95)<2000'],
        http_req_failed: ['rate<0.01'],
        checks: ['rate>0.99'],
    },
};

export function setup() {
    const username = `perf${Date.now()}`;
    const password = 'QaPassword123!';

    const register = http.post(
        `${BASE_URL}/api/auth/register`,
        JSON.stringify({
            username,
            password,
        }),
        {
            headers: {
                'Content-Type': 'application/json',
            },
        }
    );

    check(register, {
        'registro setup exitoso': (r) =>
            r.status === 200 || r.status === 201,
    });

    const login = http.post(
        `${BASE_URL}/api/auth/login`,
        JSON.stringify({
            username,
            password,
        }),
        {
            headers: {
                'Content-Type': 'application/json',
            },
        }
    );

    check(login, {
        'login setup exitoso': (r) => r.status === 200,
    });

    const data = login.json();

    const payloadPart = data.accessToken.split('.')[1];
    const payloadJson = encoding.b64decode(
        payloadPart,
        'rawurl',
        's'
    );

    const payload = JSON.parse(payloadJson);

    return {
        token: data.accessToken,
        userId: payload.sub,
    };
}

export default function (data) {
    const headers = {
        Authorization: `Bearer ${data.token}`,
    };

    // 1. Disponibilidad a través de nginx
    const health = http.get(
        `${BASE_URL}/actuator/health/readiness`,
        {
            tags: { endpoint: 'readiness' },
        }
    );

    check(health, {
        'readiness 200': (r) => r.status === 200,
    });

    // 2. Endpoint autenticado real
    const profile = http.get(
        `${BASE_URL}/api/users/${data.userId}`,
        {
            headers,
            tags: { endpoint: 'user-profile' },
        }
    );

    check(profile, {
        'perfil responde 200': (r) => r.status === 200,
        'perfil responde antes de 2s': (r) =>
            r.timings.duration < 2000,
    });

    sleep(1);
}