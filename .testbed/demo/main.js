// @ts-check

/**
 * Demo root used by concrete repos as a starting point.
 *
 * @type {HTMLElement | null}
 */
const app = document.querySelector("#app");

if (app instanceof HTMLElement) {
  app.textContent = "Replace this demo with repo-owned Web Components.";
}
