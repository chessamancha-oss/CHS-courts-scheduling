const loginForm = document.getElementById("adminLoginForm");
const loginError = document.getElementById("adminLoginError");

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  loginError.textContent = "";
  const button = loginForm.querySelector('[type="submit"]');
  button.disabled = true;
  button.textContent = "Signing in…";
  try {
    const response = await fetch("/api/admin-login", {
      method: "POST",
      cache: "no-store",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", "Accept": "application/json" },
      body: JSON.stringify({
        email: document.getElementById("adminLoginEmail").value.trim(),
        password: document.getElementById("adminLoginPassword").value
      })
    });
    const responseType = response.headers.get("Content-Type") || "";
    if (!responseType.includes("application/json")) {
      throw new Error("The Admin Portal service is not active on this deployment. Upload the Cloudflare production ZIP and try again.");
    }
    let data = {};
    try { data = await response.json(); } catch (_) { /* handled below */ }
    if (!response.ok) throw new Error(data.message || "Sign-in failed.");
    if (data.ok !== true) throw new Error("The Admin Portal did not confirm the sign-in. Please try again.");
    window.location.replace("/admin");
  } catch (error) {
    loginError.textContent = error.message;
  } finally {
    button.disabled = false;
    button.textContent = "Sign in securely";
  }
});
