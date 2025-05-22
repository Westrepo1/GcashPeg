document.addEventListener("DOMContentLoaded", () => {
  // Check if user is logged in
  if (!localStorage.getItem("isLoggedIn")) {
    window.location.href = "/login";
    return;
  }

  // Update UI with user data
  const userNameElements = document.querySelectorAll("#user-name, #menu-user-name");
  userNameElements.forEach((el) => {
    if (el && user.first_name) el.textContent = user.first_name;
  });

  const accountNumberElement = document.getElementById("account-number");
  if (accountNumberElement && user.accNo) {
    accountNumberElement.textContent = user.accNo;
  }

  const checkingBalanceElement = document.getElementById("checking-balance");
  if (checkingBalanceElement && user.balance !== undefined) {
    checkingBalanceElement.textContent = user.balance.toLocaleString(undefined, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  }

  // Handle profile button click to open side menu
  const profileBtn = document.getElementById("profile-btn");
  const profileNav = document.getElementById("profile-nav");
  const sideMenu = document.getElementById("side-menu");
  const overlay = document.getElementById("overlay");

  if ((profileBtn || profileNav) && sideMenu && overlay) {
    profileBtn.addEventListener("click", () => {
      sideMenu.classList.add("active");
      overlay.classList.add("active");
    });

    if (profileNav) {
      profileNav.addEventListener("click", () => {
        sideMenu.classList.add("active");
        overlay.classList.add("active");
      });
    }
  }

  if (overlay && sideMenu) {
    overlay.addEventListener("click", () => {
      sideMenu.classList.remove("active");
      overlay.classList.remove("active");
    });
  }

  // Handle logout
  const logoutBtn = document.getElementById("logout-btn");
  if (logoutBtn) {
    logoutBtn.addEventListener("click", (e) => {
      e.preventDefault();
      localStorage.removeItem("isLoggedIn");
      localStorage.removeItem("user");
      window.location.href = "/logout";
    });
  }

  // Handle send money button
  const sendMoneyFeature = document.getElementById("send-money-feature");
  const transferFeature = document.getElementById("transfer-feature");

  if (sendMoneyFeature) {
    sendMoneyFeature.addEventListener("click", () => {
      window.location.href = "/send-money";
    });
  }

  if (transferFeature) {
    transferFeature.addEventListener("click", () => {
      window.location.href = "/send-money";
    });
  }

  // Handle transactions feature
  const transactionsFeature = document.getElementById("transactions-feature");
  const navTransactions = document.getElementById("nav-transactions");

  if (transactionsFeature) {
    transactionsFeature.addEventListener("click", () => {
      window.location.href = `/transactions/${user._id}`;
    });
  }

  if (navTransactions) {
    navTransactions.addEventListener("click", () => {
      window.location.href = `/transactions/${user._id}`;
    });
  }

  // Handle cash in button
  const cashInBtn = document.querySelector(".cash-in-btn");
  if (cashInBtn) {
    cashInBtn.addEventListener("click", () => {
      document.getElementById("coming-soon-modal").classList.add("active");
    });
  }

  // Handle menu items (except Send and Transactions)
  const menuItems = document.querySelectorAll(
    ".menu-item:not(#send-money-feature):not(#transactions-feature):not(#transfer-feature)"
  );
  menuItems.forEach((item) => {
    item.addEventListener("click", () => {
      document.getElementById("coming-soon-modal").classList.add("active");
    });
  });

  // Close coming soon modal
  const closeModalBtn = document.getElementById("close-modal-btn");
  if (closeModalBtn) {
    closeModalBtn.addEventListener("click", () => {
      document.getElementById("coming-soon-modal").classList.remove("active");
    });
  }

  // Load recent transactions
  loadRecentTransactions();
});

// Function to load recent transactions
function loadRecentTransactions() {
  const transactionsList = document.getElementById("recent-transactions-list");
  const noTransactionsElement = document.getElementById("no-recent-transactions");

  if (!transactionsList) return;

  fetch("/api/transactions", {
    headers: {
      "Content-Type": "application/json",
    },
    credentials: 'include', // Include cookies for JWT authentication
  })
    .then((response) => {
      if (!response.ok) {
        return response.json().then((errorData) => {
          throw new Error(errorData.message || 'Failed to fetch transactions');
        });
      }
      return response.json();
    })
    .then((data) => {
      if (data.success && data.transactions && data.transactions.length > 0) {
        // Filter transactions for the current user (already filtered by backend, but double-check)
        const userTransactions = data.transactions.filter(
          (t) => t.senderAccountNumber === user.accNo || t.recipientAccountNumber === user.accNo
        );

        // Sort by date (newest first)
        userTransactions.sort((a, b) => new Date(b.date) - new Date(a.date));

        // Take only the 5 most recent
        const recentTransactions = userTransactions.slice(0, 5);

        if (recentTransactions.length > 0) {
          // Hide no transactions message
          if (noTransactionsElement) {
            noTransactionsElement.style.display = "none";
          }

          // Clear existing transactions
          transactionsList.innerHTML = "";

          // Add transactions to the list
          recentTransactions.forEach((transaction) => {
            const isCredit = transaction.recipientAccountNumber === user.accNo;
            const transactionItem = document.createElement("div");
            transactionItem.className = `transaction-item ${isCredit ? "credit" : "debit"}`;

            const formattedDate = new Date(transaction.date).toLocaleDateString();
            const formattedAmount =
              "₱" +
              transaction.amount.toLocaleString(undefined, {
                minimumFractionDigits: 2,
                maximumFractionDigits: 2,
              });

            transactionItem.innerHTML = `
              <div class="transaction-content">
                <div class="transaction-icon ${isCredit ? "credit" : "debit"}">
                  <i class="fas ${isCredit ? "fa-arrow-down" : "fa-arrow-up"}"></i>
                </div>
                <div class="transaction-details">
                  <div class="transaction-title">${isCredit ? "Received from" : "Sent to"} ${
                    isCredit ? transaction.senderName || "Unknown Sender" : transaction.recipientName || "Unknown Recipient"
                  }</div>
                  <div class="transaction-date">${formattedDate}</div>
                  ${transaction.note ? `<div class="transaction-note">${transaction.note}</div>` : ""}
                </div>
              </div>
              <div class="transaction-amount ${isCredit ? "credit" : "debit"}">
                ${isCredit ? "+" : "-"}${formattedAmount}
              </div>
            `;

            transactionsList.appendChild(transactionItem);
          });
        }
      }
    })
    .catch((error) => {
      console.error("Error fetching transactions:", error);
      if (noTransactionsElement) {
        noTransactionsElement.textContent = `Error loading transactions: ${error.message}`;
      }
    });
}