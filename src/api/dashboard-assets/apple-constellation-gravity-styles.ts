export function renderConstellationGravityStyles(): string {
  return `
.constellation-gravity {
  position: relative;
  padding: 18px 0 14px 6px;
  overflow: visible;
}

.constellation-gravity::before {
  content: "";
  position: absolute;
  top: 18px;
  right: -76px;
  bottom: 12px;
  width: 170px;
  border-radius: 999px;
  background:
    radial-gradient(circle at 100% 48%, rgba(76, 174, 255, 0.34), transparent 0 5px, transparent 7px),
    linear-gradient(90deg, transparent, rgba(67, 171, 255, 0.08), transparent);
  opacity: 0.88;
  filter: blur(0.2px);
  pointer-events: none;
}

.constellation-gravity .constellation-section-label,
.constellation-gravity .constellation-section-subtitle {
  margin-left: 4px;
}

.constellation-issue-list {
  position: relative;
  display: grid;
  gap: 12px;
  padding-top: 2px;
  overflow: visible;
}

.gravity-row {
  --gravity-accent: #4fb7ff;
  --gravity-accent-rgb: 79, 183, 255;
  position: relative;
  min-height: 68px;
  width: min(100%, 306px);
  display: grid;
  grid-template-columns: 50px minmax(0, 1fr) 58px;
  align-items: center;
  gap: 9px;
  padding: 10px 14px 10px 11px;
  border: 1px solid rgba(var(--gravity-accent-rgb), 0.18);
  border-radius: 26px;
  color: #d9ecfb;
  background:
    radial-gradient(circle at 18% 50%, rgba(var(--gravity-accent-rgb), 0.2), transparent 0 30%, transparent 52%),
    linear-gradient(135deg, rgba(15, 29, 40, 0.9), rgba(4, 13, 20, 0.7));
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.07),
    inset 0 -18px 34px rgba(0, 0, 0, 0.22),
    0 18px 46px rgba(0, 0, 0, 0.24);
  cursor: pointer;
  overflow: visible;
  transition:
    border-color 180ms ease,
    box-shadow 180ms ease,
    transform 180ms ease;
}

.gravity-row::after {
  content: "";
  position: absolute;
  inset: 1px;
  border-radius: inherit;
  background: linear-gradient(90deg, rgba(255, 255, 255, 0.05), transparent 36%);
  pointer-events: none;
}

.gravity-row-focus {
  --gravity-accent: #57aaff;
  --gravity-accent-rgb: 87, 170, 255;
  border-color: rgba(var(--gravity-accent-rgb), 0.82);
  background:
    radial-gradient(circle at 13% 50%, rgba(66, 153, 255, 0.36), transparent 0 34%, transparent 58%),
    linear-gradient(135deg, rgba(13, 44, 86, 0.96), rgba(4, 19, 33, 0.82));
  box-shadow:
    0 0 0 1px rgba(96, 178, 255, 0.22),
    0 0 24px rgba(66, 153, 255, 0.56),
    0 22px 62px rgba(0, 0, 0, 0.34),
    inset 0 1px 0 rgba(255, 255, 255, 0.16);
}

.gravity-row-running {
  --gravity-accent: #5ecbff;
  --gravity-accent-rgb: 94, 203, 255;
}

.gravity-row-warning {
  --gravity-accent: #ffc35c;
  --gravity-accent-rgb: 255, 195, 92;
}

.gravity-row-blocked {
  --gravity-accent: #ff6f63;
  --gravity-accent-rgb: 255, 111, 99;
}

.gravity-row:hover,
.gravity-row:focus-visible {
  border-color: rgba(var(--gravity-accent-rgb), 0.68);
  box-shadow:
    0 0 0 1px rgba(var(--gravity-accent-rgb), 0.16),
    0 0 26px rgba(var(--gravity-accent-rgb), 0.36),
    0 22px 58px rgba(0, 0, 0, 0.32),
    inset 0 1px 0 rgba(255, 255, 255, 0.12);
  outline: none;
  transform: translateX(7px);
}

.gravity-glyph {
  position: relative;
  z-index: 1;
  width: 42px;
  height: 42px;
  display: grid;
  place-items: center;
  border: 1px solid rgba(var(--gravity-accent-rgb), 0.55);
  border-radius: 50%;
  color: var(--gravity-accent);
  font-family: "SF Mono", "Menlo", monospace;
  font-size: 18px;
  font-weight: 800;
  text-shadow: 0 0 16px rgba(var(--gravity-accent-rgb), 0.9);
  background:
    radial-gradient(circle, rgba(var(--gravity-accent-rgb), 0.22), rgba(var(--gravity-accent-rgb), 0.06) 54%, rgba(0, 0, 0, 0.32));
  box-shadow:
    0 0 18px rgba(var(--gravity-accent-rgb), 0.34),
    inset 0 0 14px rgba(var(--gravity-accent-rgb), 0.2);
}

.gravity-copy {
  position: relative;
  z-index: 1;
  min-width: 0;
  display: grid;
  gap: 2px;
  line-height: 1.1;
}

.gravity-identifier {
  color: var(--gravity-accent);
  font-size: 14px;
  font-weight: 800;
  letter-spacing: 0.01em;
}

.gravity-title,
.gravity-detail {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.gravity-title {
  color: #dce9f5;
  font-size: 12px;
  font-weight: 650;
}

.gravity-detail {
  color: #8fb3cf;
  font-size: 12px;
}

.gravity-value {
  position: relative;
  z-index: 1;
  display: grid;
  justify-items: end;
  gap: 2px;
  color: #a8b7c4;
}

.gravity-score {
  color: #c6d2dc;
  font-size: 16px;
  font-weight: 500;
  font-variant-numeric: tabular-nums;
}

.gravity-unit {
  color: #7f91a0;
  font-size: 11px;
}

.gravity-strand {
  --strand-width: 224px;
  --strand-bend: 72px;
  --strand-tilt: 0deg;
  --strand-sweep: 1;
  position: absolute;
  z-index: 2;
  top: 50%;
  left: calc(100% - 2px);
  width: var(--strand-width);
  height: var(--strand-bend);
  pointer-events: none;
  transform:
    translateY(calc(-50% + var(--strand-lift, 0px)))
    rotate(var(--strand-tilt));
  transform-origin: 0 50%;
  filter: drop-shadow(0 0 8px rgba(var(--gravity-accent-rgb), 0.78));
  opacity: 0.92;
}

.gravity-strand::before,
.gravity-strand::after {
  content: "";
  position: absolute;
  inset: 0;
  border-radius: 50%;
  transform: scaleY(var(--strand-sweep));
  pointer-events: none;
}

.gravity-strand::before {
  border: 1px solid transparent;
  border-top-color: rgba(var(--gravity-accent-rgb), 0.72);
  border-right-color: rgba(var(--gravity-accent-rgb), 0.48);
  box-shadow:
    inset -20px 20px 22px rgba(var(--gravity-accent-rgb), 0.04),
    0 0 16px rgba(var(--gravity-accent-rgb), 0.28);
}

.gravity-strand::after {
  inset: 7px 10px 8px 18px;
  border: 1px dotted rgba(241, 250, 255, 0.46);
  border-left-color: transparent;
  border-bottom-color: transparent;
  opacity: 0.62;
  mask-image: linear-gradient(90deg, transparent, #000 14%, #000 86%, transparent);
}

.gravity-dot {
  position: absolute;
  z-index: 1;
  top: 50%;
  right: -6px;
  width: 11px;
  height: 11px;
  border-radius: 50%;
  transform: translateY(-50%);
  background: #f6fbff;
  box-shadow:
    0 0 0 4px rgba(var(--gravity-accent-rgb), 0.16),
    0 0 18px rgba(var(--gravity-accent-rgb), 1);
}

.gravity-dot::after {
  content: "";
  position: absolute;
  inset: -16px;
  border: 1px solid rgba(var(--gravity-accent-rgb), 0.2);
  border-radius: 50%;
}

.gravity-row-focus .gravity-strand {
  filter: drop-shadow(0 0 11px rgba(var(--gravity-accent-rgb), 0.92));
  opacity: 1;
}

.gravity-row-focus .gravity-strand::before {
  border-top-width: 2px;
  border-right-width: 2px;
}

.gravity-row:hover .gravity-strand,
.gravity-row:focus-visible .gravity-strand {
  filter: drop-shadow(0 0 13px rgba(var(--gravity-accent-rgb), 0.98));
  opacity: 1;
}

.gravity-row:hover .gravity-dot,
.gravity-row:focus-visible .gravity-dot {
  animation: gravity-dot-pulse 1100ms ease-in-out infinite;
}

@keyframes gravity-dot-pulse {
  0%,
  100% {
    transform: translateY(-50%) scale(1);
  }
  50% {
    transform: translateY(-50%) scale(1.22);
  }
}

@media (max-width: 1180px) {
  .constellation-gravity {
    padding-right: 8px;
  }

  .constellation-gravity::before,
  .gravity-strand {
    display: none;
  }

  .gravity-row {
    width: 100%;
  }
}
`;
}
