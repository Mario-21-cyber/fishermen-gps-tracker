const $ = (s) => document.querySelector(s);

// kung may session na, diretso sa dashboard; ipakita ang default-credentials hint
fetch("/api/me")
  .then((r) => r.json())
  .then((me) => {
    if (me.authenticated) window.location.href = "/";
    else if (me.mustChange) $("#default-hint").style.display = "block";
  })
  .catch(() => {});

$("#login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = $("#login-btn");
  btn.disabled = true;
  btn.textContent = "Signing in…";
  $("#login-error").textContent = "";
  try {
    const r = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: $("#username").value.trim(),
        password: $("#password").value,
      }),
    });
    const out = await r.json();
    if (!r.ok) throw new Error(out.error || "Login failed");
    if (out.mustChange) $("#default-hint").style.display = "block";
    window.location.href = "/";
  } catch (err) {
    $("#login-error").textContent = err.message;
    btn.disabled = false;
    btn.textContent = "Sign in as admin";
  }
});