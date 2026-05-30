export function renderAppleConstellationHtml(): string {
  return `<main class="apple-constellation" aria-label="Agent operations console">
    <section class="constellation-stage" aria-label="Agent activity and command safety">
      <aside class="constellation-gravity" aria-label="Active issue queue">
        <div class="constellation-section-label">Active Queue</div>
        <p class="constellation-section-subtitle">Issues ordered by operator attention</p>
        <div id="constellation-issue-list" class="constellation-issue-list"></div>
      </aside>

      <section class="constellation-lens" aria-label="Focused agent lens">
        <div class="constellation-refresh">
          <span>Auto Refresh</span>
          <strong id="constellation-refresh-pulse">1.2s</strong>
        </div>
        <div id="constellation-core" class="constellation-core"></div>
      </section>

      <aside class="constellation-interlocks" aria-label="Command checks">
        <div class="constellation-section-label">Command Checks</div>
        <p class="constellation-section-subtitle">Safety gates before operator actions</p>
        <div id="constellation-interlock-list" class="constellation-interlock-list"></div>
      </aside>
    </section>

    <section class="constellation-evidence" aria-label="Run evidence">
      <div id="constellation-evidence-path" class="constellation-evidence-path"></div>
      <div id="constellation-actions" class="constellation-actions"></div>
    </section>

    <footer class="constellation-footer" aria-label="System status">
      <div>Operator <strong id="constellation-operator">niels</strong></div>
      <div>Snapshot Time <strong id="constellation-runtime-clock">--:--:--</strong></div>
      <div>API <strong id="constellation-api-health">Healthy</strong></div>
      <div>Workers <strong id="constellation-worker-count">0 / 0</strong></div>
      <div>Blocked + Retry <strong id="constellation-queue-count">0</strong></div>
    </footer>
  </main>`;
}
