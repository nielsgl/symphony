export function renderConstellationInterlockStyles(): string {
  return `
.constellation-interlocks {
  position: relative;
  padding: 18px 0 14px 0;
  overflow: visible;
}

.constellation-interlock-list {
  position: relative;
  display: grid;
  gap: 12px;
  padding: 10px 0 0 0;
}

.constellation-interlock-list::before {
  content: "";
  position: absolute;
  top: 14px;
  bottom: 18px;
  left: 38px;
  width: 2px;
  border-radius: 999px;
  background:
    linear-gradient(180deg, rgba(79, 181, 255, 0.02), rgba(255, 200, 97, 0.92) 34%, rgba(255, 200, 97, 0.86) 70%, rgba(129, 255, 149, 0.72));
  box-shadow:
    0 0 18px rgba(255, 198, 87, 0.44),
    0 0 34px rgba(89, 169, 255, 0.2);
}

.interlock-step {
  --interlock-accent: #ffc35c;
  --interlock-accent-rgb: 255, 195, 92;
  position: relative;
  min-height: 78px;
  display: grid;
  grid-template-columns: 70px minmax(0, 1fr);
  align-items: center;
  color: #e5f0f8;
}

.interlock-step::before {
  content: "";
  position: absolute;
  left: -118px;
  top: 48%;
  width: 136px;
  height: 58px;
  border-left: 1px solid rgba(var(--interlock-accent-rgb), 0.44);
  border-top: 1px solid rgba(var(--interlock-accent-rgb), 0.62);
  border-radius: 999px 0 0 0;
  filter: drop-shadow(0 0 9px rgba(var(--interlock-accent-rgb), 0.8));
  opacity: 0.8;
  pointer-events: none;
}

.interlock-step:nth-child(2n)::before {
  transform: translateY(-30%) scaleY(-1);
}

.interlock-step-verified {
  --interlock-accent: #72d98c;
  --interlock-accent-rgb: 114, 217, 140;
}

.interlock-step-attention {
  --interlock-accent: #ffc35c;
  --interlock-accent-rgb: 255, 195, 92;
}

.interlock-step-receipt {
  --interlock-accent: #98f7a3;
  --interlock-accent-rgb: 152, 247, 163;
}

.interlock-node {
  position: relative;
  z-index: 2;
  width: 52px;
  height: 52px;
  display: grid;
  place-items: center;
  justify-self: center;
  border: 2px solid rgba(var(--interlock-accent-rgb), 0.86);
  border-radius: 50%;
  color: #f7fbff;
  font-family: "SF Mono", "Menlo", monospace;
  font-size: 12px;
  font-weight: 850;
  letter-spacing: 0.06em;
  text-shadow: 0 0 14px rgba(var(--interlock-accent-rgb), 0.95);
  background:
    radial-gradient(circle, rgba(var(--interlock-accent-rgb), 0.28), rgba(6, 18, 28, 0.98) 58%),
    linear-gradient(180deg, rgba(255, 255, 255, 0.11), rgba(255, 255, 255, 0.01));
  box-shadow:
    0 0 0 6px rgba(var(--interlock-accent-rgb), 0.08),
    0 0 26px rgba(var(--interlock-accent-rgb), 0.62),
    inset 0 0 16px rgba(var(--interlock-accent-rgb), 0.26);
}

.interlock-step-body {
  position: relative;
  min-width: 0;
  padding: 12px 16px;
  border: 1px solid rgba(var(--interlock-accent-rgb), 0.18);
  border-radius: 18px;
  background:
    radial-gradient(circle at 8% 0%, rgba(var(--interlock-accent-rgb), 0.13), transparent 0 38%, transparent 60%),
    linear-gradient(145deg, rgba(19, 32, 40, 0.86), rgba(4, 13, 19, 0.8));
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.08),
    inset 0 -22px 42px rgba(0, 0, 0, 0.23),
    0 18px 48px rgba(0, 0, 0, 0.26);
  overflow: hidden;
}

.interlock-step-body::after {
  content: "";
  position: absolute;
  inset: 1px;
  border-radius: inherit;
  background: linear-gradient(105deg, rgba(255, 255, 255, 0.06), transparent 38%);
  pointer-events: none;
}

.interlock-step-header,
.interlock-check,
.interlock-action,
.interlock-preview {
  position: relative;
  z-index: 1;
}

.interlock-step-header {
  display: flex;
  align-items: center;
  gap: 12px;
  color: #eaf4fb;
  text-transform: uppercase;
}

.interlock-number {
  color: #cbd6df;
  font-size: 13px;
  font-weight: 800;
  font-variant-numeric: tabular-nums;
}

.interlock-title {
  font-size: 11px;
  font-weight: 850;
  letter-spacing: 0.13em;
}

.interlock-subtitle {
  margin-top: 4px;
  color: #bac7d1;
  font-size: 11px;
}

.interlock-step-verified .interlock-subtitle,
.interlock-step-receipt .interlock-subtitle {
  color: #91e99f;
}

.interlock-checks {
  position: relative;
  z-index: 1;
  display: grid;
  gap: 4px;
  margin-top: 8px;
}

.interlock-check {
  display: grid;
  grid-template-columns: 22px minmax(0, 1fr) auto;
  align-items: center;
  gap: 6px;
  color: #b8c8d3;
  font-size: 11px;
}

.interlock-check-glyph {
  width: 16px;
  height: 16px;
  display: grid;
  place-items: center;
  border: 1px solid currentColor;
  border-radius: 50%;
  font-size: 7px;
  font-weight: 850;
  line-height: 1;
}

.interlock-check-ok {
  color: #8fe79d;
}

.interlock-check-attention {
  color: #ffc35c;
}

.interlock-check-label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.interlock-check-detail {
  color: #7f8f9b;
  font-size: 11px;
}

.interlock-action {
  margin-top: 10px;
  min-height: 36px;
  width: 100%;
  border: 1px solid rgba(255, 195, 92, 0.48);
  border-radius: 12px;
  color: #ffd180;
  background:
    radial-gradient(circle at 18% 50%, rgba(255, 195, 92, 0.2), transparent 0 36%, transparent 62%),
    rgba(255, 195, 92, 0.08);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.12), 0 0 22px rgba(255, 195, 92, 0.14);
  font: inherit;
  font-size: 12px;
  font-weight: 760;
  text-align: left;
  padding: 0 16px;
}

.interlock-preview {
  margin: 10px 0 0;
  max-height: 100px;
  padding: 12px 14px;
  border: 1px solid rgba(255, 195, 92, 0.18);
  border-radius: 12px;
  color: #bdc8d0;
  background: rgba(2, 8, 12, 0.58);
  font-family: "SF Mono", "Menlo", monospace;
  font-size: 10px;
  line-height: 1.45;
  white-space: pre-wrap;
  overflow: hidden;
}

.constellation-evidence {
  position: relative;
  margin-top: -104px;
  padding: 0;
  pointer-events: none;
}

.constellation-evidence-path {
  position: relative;
  min-height: 112px;
  width: min(620px, 46vw);
  margin: 0 auto;
}

.evidence-rail {
  position: relative;
  min-height: 74px;
  display: grid;
  grid-template-columns: repeat(4, minmax(96px, 1fr));
  align-items: center;
  gap: 0;
  padding: 12px 46px;
  border: 1px solid rgba(129, 255, 149, 0.28);
  border-radius: 999px;
  background:
    radial-gradient(circle at 50% 0%, rgba(129, 255, 149, 0.17), transparent 0 44%, transparent 68%),
    linear-gradient(180deg, rgba(15, 40, 30, 0.76), rgba(3, 14, 13, 0.72));
  box-shadow:
    0 0 26px rgba(129, 255, 149, 0.18),
    inset 0 1px 0 rgba(255, 255, 255, 0.08);
}

.evidence-rail::before {
  content: "Evidence Path";
  position: absolute;
  left: 0;
  bottom: -22px;
  color: #4bff74;
  font-size: 10px;
  font-weight: 850;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  text-shadow: 0 0 14px rgba(84, 255, 116, 0.62);
}

.evidence-node {
  --evidence-accent: #63b7ff;
  --evidence-accent-rgb: 99, 183, 255;
  position: relative;
  min-width: 0;
  display: grid;
  gap: 2px;
  padding-left: 28px;
  color: #dbeefc;
}

.evidence-node::before {
  content: "";
  position: absolute;
  left: 2px;
  top: 50%;
  width: 16px;
  height: 16px;
  border: 1px solid rgba(var(--evidence-accent-rgb), 0.74);
  border-radius: 50%;
  transform: translateY(-50%);
  background: rgba(var(--evidence-accent-rgb), 0.18);
  box-shadow: 0 0 14px rgba(var(--evidence-accent-rgb), 0.72);
}

.evidence-node::after {
  content: ">";
  position: absolute;
  right: 12px;
  top: 50%;
  color: rgba(219, 238, 252, 0.42);
  transform: translateY(-50%);
}

.evidence-node:last-child::after {
  display: none;
}

.evidence-node-green {
  --evidence-accent: #7df894;
  --evidence-accent-rgb: 125, 248, 148;
}

.evidence-node-amber {
  --evidence-accent: #ffc35c;
  --evidence-accent-rgb: 255, 195, 92;
}

.evidence-node-violet {
  --evidence-accent: #b89cff;
  --evidence-accent-rgb: 184, 156, 255;
}

.evidence-node-label {
  color: var(--evidence-accent);
  font-size: 11px;
  font-weight: 850;
  letter-spacing: 0.05em;
}

.evidence-node-detail {
  min-width: 0;
  overflow: hidden;
  color: #9eb1c0;
  font-size: 10px;
  font-weight: 550;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.evidence-cards {
  position: relative;
  display: grid;
  grid-template-columns: minmax(220px, 1.6fr) minmax(140px, 0.8fr);
  gap: 14px;
  width: 72%;
  margin: 10px auto 0;
}

.evidence-card {
  min-height: 36px;
  display: grid;
  align-items: center;
  border: 1px solid rgba(129, 255, 149, 0.2);
  border-radius: 999px;
  color: #b7c8d4;
  background: rgba(5, 17, 20, 0.82);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.08), 0 0 18px rgba(129, 255, 149, 0.1);
  font-size: 12px;
  padding: 0 18px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.constellation-actions {
  position: relative;
  z-index: 2;
  min-height: 78px;
  display: grid;
  grid-template-columns: 1.22fr 1fr 1.08fr 1.08fr 1fr 0.42fr;
  gap: 16px;
  margin-top: 12px;
  padding: 10px 0 0;
  pointer-events: auto;
}

.constellation-action {
  --action-accent: #5aaeff;
  --action-accent-rgb: 90, 174, 255;
  position: relative;
  min-width: 0;
  min-height: 0;
  height: 76px;
  display: grid;
  grid-template-columns: 50px minmax(0, 1fr);
  grid-template-rows: 1fr 1fr;
  align-items: center;
  column-gap: 12px;
  border: 1px solid rgba(var(--action-accent-rgb), 0.28);
  border-radius: 18px;
  color: #e9f5ff;
  background:
    radial-gradient(circle at 18% 50%, rgba(var(--action-accent-rgb), 0.28), transparent 0 36%, transparent 62%),
    linear-gradient(145deg, rgba(20, 46, 67, 0.86), rgba(6, 18, 27, 0.82));
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.12),
    0 16px 40px rgba(0, 0, 0, 0.28),
    0 0 24px rgba(var(--action-accent-rgb), 0.18);
  font: inherit;
  padding: 10px 16px;
  text-align: left;
}

.constellation-action-blue {
  --action-accent: #5aaeff;
  --action-accent-rgb: 90, 174, 255;
}

.constellation-action-green {
  --action-accent: #8af59b;
  --action-accent-rgb: 138, 245, 155;
}

.constellation-action-violet {
  --action-accent: #b69bff;
  --action-accent-rgb: 182, 155, 255;
}

.constellation-action-amber {
  --action-accent: #ffc35c;
  --action-accent-rgb: 255, 195, 92;
}

.constellation-action-neutral {
  --action-accent: #8da3b6;
  --action-accent-rgb: 141, 163, 182;
}

.constellation-action-orb {
  grid-row: 1 / 3;
  width: 42px;
  height: 42px;
  display: grid;
  place-items: center;
  border: 1px solid rgba(var(--action-accent-rgb), 0.62);
  border-radius: 50%;
  color: var(--action-accent);
  font-weight: 850;
  text-shadow: 0 0 14px rgba(var(--action-accent-rgb), 0.92);
  background: rgba(var(--action-accent-rgb), 0.12);
  box-shadow: 0 0 18px rgba(var(--action-accent-rgb), 0.28), inset 0 0 14px rgba(var(--action-accent-rgb), 0.18);
}

.constellation-action-label {
  align-self: end;
  min-width: 0;
  color: var(--action-accent);
  font-size: 13px;
  font-weight: 800;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.constellation-action-detail {
  align-self: start;
  min-width: 0;
  color: #9eb0bf;
  font-size: 11px;
  line-height: 1.2;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.constellation-action-neutral {
  grid-template-columns: 1fr;
  justify-items: center;
  text-align: center;
}

.constellation-action-neutral .constellation-action-orb {
  grid-row: auto;
}

.constellation-action-neutral .constellation-action-label {
  display: block;
  align-self: start;
  max-width: 100%;
  color: #8da3b6;
  font-size: 11px;
  text-align: center;
}

.constellation-action-neutral .constellation-action-detail {
  display: none;
}

.constellation-footer {
  background:
    linear-gradient(180deg, rgba(5, 18, 26, 0.92), rgba(2, 8, 13, 0.92));
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.07),
    0 -14px 42px rgba(0, 0, 0, 0.22);
}

.constellation-footer div {
  position: relative;
  min-width: 0;
  border-right: 1px solid rgba(130, 180, 220, 0.14);
  font-size: 11px;
  letter-spacing: 0.01em;
}

.constellation-footer div:last-child {
  border-right: 0;
}

.constellation-footer strong {
  overflow: hidden;
  font-size: 12px;
  font-weight: 650;
  text-overflow: ellipsis;
  white-space: nowrap;
}

@media (max-width: 1180px) {
  .interlock-step::before {
    display: none;
  }

  .constellation-evidence {
    margin-top: 18px;
    padding: 0;
  }

  .constellation-actions {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@media (max-width: 720px) {
  .interlock-step {
    grid-template-columns: 58px minmax(0, 1fr);
  }

  .constellation-interlock-list::before {
    left: 28px;
  }

  .interlock-node {
    width: 46px;
    height: 46px;
    font-size: 10px;
  }

  .evidence-rail,
  .evidence-cards,
  .constellation-actions {
    grid-template-columns: 1fr;
  }

  .evidence-cards {
    width: 100%;
  }
}
`;
}
