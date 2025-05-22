document.addEventListener("DOMContentLoaded", () => {
  const loginForm = document.getElementById("login-form");
  const emailInput = document.getElementById("email");
  const passwordInput = document.getElementById("password");
  const loginBtn = document.getElementById("login-btn");
  const errorMessage = document.getElementById("error-message");

  if (loginForm) {
    loginForm.addEventListener("submit", async (e) => {
      e.preventDefault();

      // Reset error message
      errorMessage.style.display = "none";
      errorMessage.textContent = "";

      // Validate inputs
      if (!emailInput.value || !passwordInput.value) {
        errorMessage.textContent = "Please enter both email and password";
        errorMessage.style.display = "block";
        return;
      }

      // Show loading state
      loginBtn.textContent = "Signing In...";
      loginBtn.disabled = true;

      try {
        const response = await fetch("/login", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            email: emailInput.value,
            password: passwordInput.value,
          }),
        });

        const data = await response.json();

        if (data.success) {
          localStorage.setItem("isLoggedIn", "true");
          localStorage.setItem("user", JSON.stringify(data.user));
          window.location.href = "/dashboard";
        } else {
          errorMessage.textContent =
            Object.values(data.errors).find((err) => err) ||
            "Invalid email or password";
          errorMessage.style.display = "block";
        }
      } catch (error) {
        console.error("Error:", error);
        errorMessage.textContent = "An error occurred. Please try again.";
        errorMessage.style.display = "block";
      } finally {
        loginBtn.textContent = "Sign In";
        loginBtn.disabled = false;
      }
    });
  }
});