const loginForm = document.getElementById("loginForm");
const message = document.getElementById("message");

loginForm.addEventListener("submit", async function (event) {
    event.preventDefault();

    const username = document.getElementById("username").value;
    const password = document.getElementById("password").value;

    message.textContent = "Autenticando...";

    try {

        const response = await fetch(
            "http://localhost:8080/api/auth/login",
            {
                method: "POST",

                headers: {
                    "Content-Type": "application/json"
                },

                body: JSON.stringify({
                    username: username,
                    password: password
                })
            }
        );

        const data = await response.json();

        if (response.ok) {

            localStorage.setItem(
                "authToken",
                data.token
            );

            message.textContent =
                "Inicio de sesión exitoso. Bienvenido " +
                data.username;

        } else {

            message.textContent =
                data.message ||
                "Usuario o contraseña incorrectos";
        }

    } catch (error) {

        console.error(
            "Error comunicándose con el backend:",
            error
        );

        message.textContent =
            "El servicio de autenticación no está disponible.";
    }
});