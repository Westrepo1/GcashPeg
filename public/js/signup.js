document.addEventListener("DOMContentLoaded", () => {
  const signupForm = document.getElementById("signup-form");
  const firstNameInput = document.getElementById("firstName");
  const lastNameInput = document.getElementById("lastName");
  const emailInput = document.getElementById("email");
  const passwordInput = document.getElementById("password");
  const confirmPasswordInput = document.getElementById("confirmPassword");
  const signupBtn = document.getElementById("signup-btn");
  const errorMessage = document.getElementById("error-message");

  if (signupForm) {
    signupForm.addEventListener("submit", async (e) => {
      e.preventDefault();

      // Reset error message
      errorMessage.style.display = "none";
      errorMessage.textContent = "";

      // Validate inputs
      if (
        !firstNameInput.value ||
        !lastNameInput.value ||
        !emailInput.value ||
        !passwordInput.value ||
        !confirmPasswordInput.value
      ) {
        errorMessage.textContent = "Please fill in all fields";
        errorMessage.style.display = "block";
        return;
      }

      if (passwordInput.value !== confirmPasswordInput.value) {
        errorMessage.textContent = "Passwords do not match";
        errorMessage.style.display = "block";
        return;
      }

      if (passwordInput.value.length < 6) {
        errorMessage.textContent = "Password must be at least 6 characters";
        errorMessage.style.display = "block";
        return;
      }

      // Show loading state
      signupBtn.textContent = "Creating Account...";
      signupBtn.disabled = true;

      try {
        const response = await fetch("/signup", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            first_name: firstNameInput.value,
            last_name: lastNameInput.value,
            email: emailInput.value,
            password1: passwordInput.value,
            password2: confirmPasswordInput.value,
          }),
        });

        const data = await response.json();

        if (data.success) {
          window.location.href = data.redirect; // Redirect to /dashboard
        } else {
          errorMessage.textContent =
            Object.values(data.errors).find((err) => err) ||
            "Failed to create account. Please try again.";
          errorMessage.style.display = "block";
        }
      } catch (error) {
        console.error("Error:", error);
        errorMessage.textContent = "An error occurred. Please try again.";
        errorMessage.style.display = "block";
      } finally {
        signupBtn.textContent = "Create Account";
        signupBtn.disabled = false;
      }
    });
  }
});