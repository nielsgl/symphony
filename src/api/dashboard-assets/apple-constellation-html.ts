export function renderAppleConstellationHtml(): string {
  return `<main class="apple-constellation" aria-label="Living Agent Lens">
    <section class="constellation-stage" aria-label="Symphony control constellation">
      <aside class="constellation-gravity" aria-label="Notification gravity">
        <div class="constellation-section-label">Notification Gravity</div>
        <p class="constellation-section-subtitle">Issues pulled toward focus</p>
        <div id="constellation-issue-list" class="constellation-issue-list"></div>
      </aside>

      <section class="constellation-lens" aria-label="Focused agent lens">
        <div class="constellation-refresh">
          <span>Live Refresh</span>
          <strong id="constellation-refresh-pulse">1.2s</strong>
        </div>
        <div id="constellation-core" class="constellation-core"></div>
      </section>

      <aside class="constellation-interlocks" aria-label="Interlock spine">
        <div class="constellation-section-label">Interlock Spine</div>
        <p class="constellation-section-subtitle">Safety before every command</p>
        <div id="constellation-interlock-list" class="constellation-interlock-list"></div>
      </aside>
    </section>

    <section class="constellation-evidence" aria-label="Evidence path">
      <div id="constellation-evidence-path" class="constellation-evidence-path"></div>
      <div id="constellation-actions" class="constellation-actions"></div>
    </section>

    <footer class="constellation-footer" aria-label="System status">
      <div>Operator <strong id="constellation-operator">niels</strong></div>
      <div>Runtime Time <strong id="constellation-runtime-clock">--:--:--</strong></div>
      <div>API <strong id="constellation-api-health">Healthy</strong></div>
      <div>Workers <strong id="constellation-worker-count">0 / 0</strong></div>
      <div>Queues <strong id="constellation-queue-count">0</strong></div>
    </footer>
  </main>`;
}
