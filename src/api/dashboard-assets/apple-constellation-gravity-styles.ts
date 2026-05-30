export function renderConstellationGravityStyles(): string {
  return `
.constellation-gravity {
  position: relative;
  padding: 22px 0 18px 8px;
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
  gap: 16px;
  padding-top: 2px;
  overflow: visible;
}

.gravity-row {
  --gravity-accent: #4fb7ff;
  --gravity-accent-rgb: 79, 183, 255;
  position: relative;
  min-height: 74px;
  width: min(100%, 302px);
  display: grid;
  grid-template-columns: 54px minmax(0, 1fr) 58px;
  align-items: center;
  gap: 10px;
  padding: 12px 14px 12px 12px;
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
  overflow: visible;
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

.gravity-glyph {
  position: relative;
  z-index: 1;
  width: 44px;
  height: 44px;
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
  font-size: 13px;
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
  position: absolute;
  z-index: 0;
  top: 50%;
  left: calc(100% - 2px);
  width: 194px;
  height: 54px;
  pointer-events: none;
  transform: translateY(calc(-50% + var(--strand-lift, 0px)));
  border-top: 1px solid rgba(var(--gravity-accent-rgb), 0.58);
  border-right: 1px solid rgba(var(--gravity-accent-rgb), 0.38);
  border-radius: 0 999px 0 0;
  filter: drop-shadow(0 0 7px rgba(var(--gravity-accent-rgb), 0.78));
  opacity: 0.88;
}

.gravity-row:nth-child(2n) .gravity-strand {
  height: 40px;
  border-radius: 0 999px 999px 0;
  transform: translateY(calc(-50% + var(--strand-lift, 0px))) scaleY(-1);
}

.gravity-dot {
  position: absolute;
  top: -5px;
  right: -6px;
  width: 11px;
  height: 11px;
  border-radius: 50%;
  background: #f6fbff;
  box-shadow:
    0 0 0 4px rgba(var(--gravity-accent-rgb), 0.16),
    0 0 18px rgba(var(--gravity-accent-rgb), 1);
}

.gravity-row-focus .gravity-strand {
  width: 214px;
  border-top-width: 2px;
  opacity: 1;
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
