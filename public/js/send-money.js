document.addEventListener("DOMContentLoaded", async () => {
  // Check if user is logged in
  const isLoggedIn = localStorage.getItem("isLoggedIn") === "true";
  if (!isLoggedIn) {
    window.location.href = "/login";
    return;
  }

  // Get user data from localStorage
  let user = null;
  const userString = localStorage.getItem("user");
  if (userString) {
    try {
      user = JSON.parse(userString);
    } catch (e) {
      console.error("Error parsing user data from localStorage:", e);
    }
  }

  // Fetch latest user data from backend to ensure balance is up-to-date
  const fromAccountSelect = document.getElementById("from-account");
  try {
    const response = await fetch("/api/user", {
      headers: {
        "Content-Type": "application/json",
      },
      credentials: 'include',
    });
    const data = await response.json();
    if (data.success && data.user) {
      user = data.user;
      localStorage.setItem("user", JSON.stringify(user)); // Update localStorage
      console.log("Fetched user data:", user);

      // Update from account select with balance
      if (fromAccountSelect && user.balance !== undefined) {
        const formattedBalance = user.balance.toLocaleString(undefined, {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        });
        fromAccountSelect.innerHTML = `<option value="checking">GCash Account - ₱${formattedBalance}</option>`;
        fromAccountSelect.disabled = true; // Disable since there's only one option
      } else {
        console.warn("Balance undefined or select element missing");
        fromAccountSelect.innerHTML = `<option value="checking">GCash Account - ₱0.00</option>`;
      }
    } else {
      console.error("Failed to fetch user data:", data.message);
      if (fromAccountSelect) {
        fromAccountSelect.innerHTML = `<option value="checking">GCash Account - ₱0.00</option>`;
      }
    }
  } catch (error) {
    console.error("Error fetching user data from backend:", error);
    // Fallback to localStorage data if available
    if (user && user.balance !== undefined && fromAccountSelect) {
      const formattedBalance = user.balance.toLocaleString(undefined, {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      });
      fromAccountSelect.innerHTML = `<option value="checking">GCash Account - ₱${formattedBalance}</option>`;
      fromAccountSelect.disabled = true;
    } else if (fromAccountSelect) {
      fromAccountSelect.innerHTML = `<option value="checking">GCash Account - ₱0.00</option>`;
    }
  }

  // Handle profile button click
  const profileBtn = document.getElementById("profile-btn");
  if (profileBtn) {
    profileBtn.addEventListener("click", () => {
      window.location.href = "/dashboard";
    });
  }

  // Handle recipient account number input to auto-fetch recipient name
  const recipientAccountInput = document.getElementById("recipient-account");
  const recipientNameDisplay = document.getElementById("recipient-name-display");
  const recipientNameInput = document.getElementById("recipient-name-input");
  let recipientNotFound = false;

  if (recipientAccountInput) {
    recipientAccountInput.addEventListener("blur", () => {
      const accountNumber = recipientAccountInput.value.trim();
      if (accountNumber) {
        fetch(`/api/user/${accountNumber}`, {
          headers: {
            "Content-Type": "application/json",
          },
          credentials: 'include',
        })
          .then((response) => response.json())
          .then((data) => {
            if (data.success && data.user) {
              recipientNameDisplay.textContent = data.user.name;
              recipientNameDisplay.style.display = "block";
              recipientNameInput.style.display = "none"; // Hide input
              recipientNotFound = false;
            } else {
              recipientNameDisplay.textContent = "Recipient not found";
              recipientNameDisplay.style.display = "block";
              recipientNameInput.style.display = "block"; // Show input
              recipientNotFound = true;
            }
          })
          .catch((error) => {
            console.error("Error fetching recipient:", error);
            recipientNameDisplay.textContent = "Error fetching recipient";
            recipientNameDisplay.style.display = "block";
            recipientNameInput.style.display = "block"; // Show input
            recipientNotFound = true;
          });
      } else {
        recipientNameDisplay.style.display = "none";
        recipientNameInput.style.display = "none";
        recipientNotFound = false;
      }
    });
  }

  // Handle send money button
  const sendMoneyBtn = document.getElementById("send-money-btn");
  const amountInput = document.getElementById("amount");
  const noteInput = document.getElementById("note");
  const errorMessage = document.getElementById("error-message");
  const transactionCodeModal = document.getElementById("transaction-code-modal");

  if (sendMoneyBtn) {
    sendMoneyBtn.addEventListener("click", () => {
      // Reset error message
      errorMessage.style.display = "none";
      errorMessage.textContent = "";

      // Validate inputs
      if (!recipientAccountInput.value) {
        errorMessage.textContent = "Please enter a recipient account number";
        errorMessage.style.display = "block";
        return;
      }

      if (!amountInput.value || Number(amountInput.value) <= 0) {
        errorMessage.textContent = "Please enter a valid amount";
        errorMessage.style.display = "block";
        return;
      }

      // Check if user has enough balance
      if (user && user.balance < Number(amountInput.value)) {
        errorMessage.textContent = "Insufficient funds";
        errorMessage.style.display = "block";
        return;
      }

      // Validate recipient name if account not found
      if (recipientNotFound && !recipientNameInput.value.trim()) {
        errorMessage.textContent = "Please enter the recipient's GCash account name";
        errorMessage.style.display = "block";
        return;
      }

      // Show transaction code modal
      if (transactionCodeModal) {
        transactionCodeModal.classList.add("active");
      }
    });
  }

  // Handle confirm transaction button
  const confirmTransactionBtn = document.getElementById("confirm-transaction-btn");
  const transactionCodeInput = document.getElementById("transaction-code");
  const modalErrorMessage = document.getElementById("modal-error-message");

  if (confirmTransactionBtn) {
    confirmTransactionBtn.addEventListener("click", async () => {
      // Reset modal error message
      modalErrorMessage.style.display = "none";
      modalErrorMessage.textContent = "";

      // Validate transaction code
      if (!transactionCodeInput.value) {
        modalErrorMessage.textContent = "Please enter the OTP code";
        modalErrorMessage.style.display = "block";
        return;
      }

      // Convert OTP input to number
      const otpValue = Number(transactionCodeInput.value);

      // Validate OTP with backend
      try {
        const otpResponse = await fetch("/api/validate-otp", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ otp: otpValue }),
          credentials: 'include',
        });

        const otpData = await otpResponse.json();

        if (!otpData.success) {
          modalErrorMessage.textContent = otpData.errors.message || "Invalid or expired OTP";
          modalErrorMessage.style.display = "block";
          return;
        }

        // Process the transaction
        const amount = Number(amountInput.value);
        const recipientAccount = recipientAccountInput.value;
        const note = noteInput.value;
        const recipientName = recipientNotFound ? recipientNameInput.value.trim() : undefined;

        const transactionResponse = await fetch("/send-money", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            recipient_account: recipientAccount,
            amount: amount,
            note: note,
            recipient_name: recipientName, // Include recipient name if provided
          }),
          credentials: 'include',
        });

        const transactionData = await transactionResponse.json();

        if (transactionData.success) {
          // Update user balance in localStorage
          user.balance -= amount;
          localStorage.setItem("user", JSON.stringify(user));

          // Save transaction data for confirmation page
          localStorage.setItem("lastTransaction", JSON.stringify(transactionData.transaction));

          // Redirect to confirmation page
          window.location.href = transactionData.redirect;
        } else {
          // Hide modal
          transactionCodeModal.classList.remove("active");

          // Show error message
          errorMessage.textContent = transactionData.errors.message || "Transaction failed. Please try again.";
          errorMessage.style.display = "block";
        }
      } catch (error) {
        console.error("Error:", error);
        transactionCodeModal.classList.remove("active");
        errorMessage.textContent = "An error occurred. Please try again.";
        errorMessage.style.display = "block";
      }
    });
  }

  // Handle bottom navigation
  const navItems = document.querySelectorAll(".nav-item");
  navItems.forEach((item, index) => {
    item.addEventListener("click", () => {
      if (index === 0) {
        // Home
        window.location.href = "/dashboard";
      } else if (index === 3) {
        // Transactions
        window.location.href = `/transactions/${user._id}`;
      } else {
        // Show coming soon modal for other nav items
        document.getElementById("coming-soon-modal").classList.add("active");
      }
    });
  });

  // Close coming soon modal
  const closeModalBtn = document.getElementById("close-modal-btn");
  if (closeModalBtn) {
    closeModalBtn.addEventListener("click", () => {
      document.getElementById("coming-soon-modal").classList.remove("active");
    });
  }
});