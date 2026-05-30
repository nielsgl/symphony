export function renderConstellationCoreStyles(): string {
  return `
.constellation-lens {
  position: relative;
  min-height: 620px;
}

.constellation-refresh {
  position: absolute;
  z-index: 4;
  top: 64px;
  left: 18px;
  display: grid;
  gap: 4px;
  color: #9ec7ec;
  font-size: 11px;
  font-weight: 800;
  letter-spacing: 0.12em;
  text-transform: uppercase;
}

.constellation-refresh strong {
  color: #d7f5ff;
  font-size: 14px;
  font-weight: 700;
  letter-spacing: 0;
  text-transform: none;
  text-shadow: 0 0 16px rgba(78, 181, 255, 0.86);
}

.constellation-core {
  position: relative;
  min-height: 620px;
}

.lens-system {
  position: absolute;
  inset: 0;
  min-height: 620px;
  overflow: visible;
  border-radius: 999px;
  background:
    radial-gradient(circle at 50% 52%, rgba(79, 179, 255, 0.28) 0 2px, transparent 3px),
    radial-gradient(circle at 50% 52%, rgba(20, 142, 255, 0.36) 0 8%, transparent 14%),
    radial-gradient(circle at 50% 52%, rgba(27, 107, 197, 0.18) 0 31%, transparent 46%),
    radial-gradient(circle at 46% 46%, rgba(77, 200, 255, 0.1), transparent 0 42%, transparent 58%),
    linear-gradient(135deg, rgba(6, 18, 29, 0.44), rgba(2, 9, 15, 0.14));
}

.lens-system::before,
.lens-system::after {
  content: "";
  position: absolute;
  inset: 52px;
  border-radius: 999px;
  pointer-events: none;
}

.lens-system::before {
  border: 1px solid rgba(84, 178, 255, 0.46);
  box-shadow:
    0 0 38px rgba(56, 151, 255, 0.64),
    inset 0 0 44px rgba(47, 146, 255, 0.22);
}

.lens-system::after {
  inset: 90px;
  border: 1px dashed rgba(54, 164, 255, 0.32);
  box-shadow: inset 0 0 80px rgba(5, 45, 82, 0.58);
}

.lens-ring {
  position: absolute;
  left: 50%;
  top: 52%;
  width: var(--lens-size);
  height: var(--lens-size);
  border-radius: 999px;
  transform: translate(-50%, -50%);
  pointer-events: none;
}

.lens-ring-outer {
  --lens-size: min(590px, 88%);
  border: 2px solid rgba(72, 160, 255, 0.68);
  box-shadow:
    0 0 18px rgba(82, 177, 255, 0.96),
    0 0 72px rgba(52, 138, 255, 0.42),
    inset 0 0 44px rgba(78, 178, 255, 0.16);
}

.lens-ring-middle {
  --lens-size: min(420px, 62%);
  border: 1px solid rgba(56, 150, 255, 0.28);
  background:
    repeating-radial-gradient(circle, transparent 0 10px, rgba(56, 150, 255, 0.07) 11px 12px),
    conic-gradient(from 18deg, transparent 0 18deg, rgba(69, 181, 255, 0.4) 20deg 22deg, transparent 24deg 74deg);
}

.lens-ring-inner {
  --lens-size: min(200px, 34%);
  border: 1px solid rgba(121, 205, 255, 0.62);
  box-shadow:
    0 0 24px rgba(68, 163, 255, 0.78),
    inset 0 0 26px rgba(68, 163, 255, 0.34);
}

.lens-focus-pill {
  position: absolute;
  z-index: 6;
  top: 58px;
  left: 50%;
  min-width: 180px;
  padding: 12px 22px 14px;
  text-align: center;
  border: 1px solid rgba(114, 205, 255, 0.72);
  border-radius: 28px;
  transform: translateX(-50%);
  background:
    linear-gradient(180deg, rgba(9, 31, 52, 0.94), rgba(4, 17, 28, 0.9)),
    radial-gradient(circle at 50% 0%, rgba(80, 184, 255, 0.24), transparent 68%);
  box-shadow:
    0 0 26px rgba(74, 175, 255, 0.48),
    inset 0 0 22px rgba(84, 191, 255, 0.12);
}

.lens-focus-id {
  color: #e6f6ff;
  font-size: 15px;
  font-weight: 800;
  letter-spacing: 0.12em;
}

.lens-focus-title {
  margin-top: 2px;
  color: #ffffff;
  font-size: 28px;
  font-weight: 800;
  line-height: 1;
}

.lens-focus-run {
  margin-top: 6px;
  color: #cde8ff;
  font-size: 13px;
}

.lens-focus-run::before {
  content: "";
  display: inline-block;
  width: 8px;
  height: 8px;
  margin-right: 7px;
  border-radius: 999px;
  background: #63c8ff;
  box-shadow: 0 0 12px rgba(99, 200, 255, 0.95);
}

.lens-label {
  color: #a7c7df;
  font-size: 11px;
  font-weight: 800;
  letter-spacing: 0.14em;
  text-transform: uppercase;
}

.lens-current-message {
  position: absolute;
  z-index: 5;
  top: 224px;
  left: 11%;
  width: min(270px, 35%);
  padding: 13px 16px;
  border: 1px solid rgba(82, 165, 255, 0.36);
  border-radius: 22px;
  background:
    linear-gradient(150deg, rgba(13, 48, 86, 0.88), rgba(4, 18, 31, 0.82)),
    radial-gradient(circle at 16% 0%, rgba(88, 183, 255, 0.24), transparent 64%);
  box-shadow:
    0 18px 48px rgba(0, 0, 0, 0.36),
    inset 0 0 20px rgba(92, 190, 255, 0.08);
}

.lens-message-role {
  margin-top: 5px;
  color: #8ecfff;
  font-size: 12px;
  font-weight: 700;
}

.lens-message-body {
  margin: 12px 0 10px;
  color: #e9f6ff;
  font-size: 12px;
  line-height: 1.45;
}

.lens-message-time {
  color: #b8d3e7;
  font-size: 12px;
}

.lens-role-stream {
  position: absolute;
  z-index: 5;
  left: 12%;
  top: 430px;
  width: min(255px, 37%);
}

.lens-stream-lanes {
  position: relative;
  display: grid;
  gap: 6px;
  margin-top: 10px;
}

.lens-stream-lane {
  position: relative;
  display: grid;
  grid-template-columns: 1fr auto;
  align-items: center;
  min-height: 15px;
  padding-left: 24px;
  color: #cfe9ff;
  font-size: 12px;
}

.lens-stream-lane::before {
  content: "";
  position: absolute;
  left: 0;
  top: 50%;
  width: calc(54px + var(--stream-count) * 10px);
  max-width: 160px;
  height: 2px;
  border-radius: 999px;
  transform: translateY(-50%);
  background: linear-gradient(90deg, transparent, var(--stream-color), transparent);
  box-shadow: 0 0 12px var(--stream-color);
}

.lens-stream-lane::after {
  content: "";
  position: absolute;
  left: calc(48px + var(--stream-count) * 8px);
  top: 50%;
  width: 5px;
  height: 5px;
  border-radius: 999px;
  transform: translateY(-50%);
  background: var(--stream-color);
  box-shadow: 0 0 12px var(--stream-color);
}

.lens-stream-assistant {
  --stream-color: #43b9ff;
}

.lens-stream-tool {
  --stream-color: #57e3a4;
}

.lens-stream-user {
  --stream-color: #ff9b55;
}

.lens-stream-system {
  --stream-color: #b095ff;
}

.lens-stream-runtime {
  --stream-color: #8db8d8;
}

.lens-stream-role {
  margin-left: 112px;
}

.lens-stream-count {
  color: #eff9ff;
  font-size: 12px;
}

.lens-event-orbit {
  position: absolute;
  z-index: 7;
  left: 50%;
  top: 52%;
  width: 1px;
  height: 1px;
}

.lens-event-node {
  --orbit-angle: 0deg;
  position: absolute;
  left: 0;
  top: 0;
  display: flex;
  align-items: center;
  gap: 12px;
  transform:
    rotate(var(--orbit-angle))
    translateX(168px)
    rotate(calc(-1 * var(--orbit-angle)));
}

.lens-event-bead {
  display: grid;
  place-items: center;
  width: 44px;
  height: 44px;
  border: 1px solid rgba(var(--event-rgb), 0.68);
  border-radius: 999px;
  color: #ffffff;
  font-size: 13px;
  font-weight: 900;
  background:
    radial-gradient(circle, rgba(var(--event-rgb), 0.34), rgba(var(--event-rgb), 0.1) 58%, rgba(2, 8, 14, 0.72));
  box-shadow:
    0 0 18px rgba(var(--event-rgb), 0.78),
    inset 0 0 16px rgba(var(--event-rgb), 0.18);
}

.lens-event-blue {
  --event-rgb: 78, 167, 255;
}

.lens-event-orange {
  --event-rgb: 255, 125, 70;
}

.lens-event-violet {
  --event-rgb: 145, 111, 255;
}

.lens-event-green {
  --event-rgb: 82, 224, 148;
}

.lens-event-cyan {
  --event-rgb: 58, 214, 238;
}

.lens-event-copy {
  display: grid;
  min-width: 86px;
  gap: 2px;
  transform: translateY(1px);
}

.lens-event-label {
  color: #eef8ff;
  font-size: 13px;
}

.lens-event-time {
  color: #a9bfd0;
  font-size: 12px;
}

.lens-core-star {
  position: absolute;
  z-index: 6;
  left: 50%;
  top: 52%;
  width: 126px;
  height: 126px;
  border: 1px solid rgba(112, 204, 255, 0.78);
  border-radius: 999px;
  transform: translate(-50%, -50%);
  overflow: hidden;
  background:
    radial-gradient(circle, #ffffff 0 2px, transparent 3px),
    radial-gradient(circle, rgba(90, 207, 255, 0.96) 0 4%, rgba(45, 132, 255, 0.42) 5% 18%, transparent 42%),
    repeating-conic-gradient(from 6deg, rgba(110, 216, 255, 0.42) 0deg 2deg, transparent 2deg 8deg),
    radial-gradient(circle, rgba(3, 24, 46, 0.96), rgba(3, 12, 22, 0.98));
  box-shadow:
    0 0 22px rgba(87, 185, 255, 0.94),
    0 0 76px rgba(55, 153, 255, 0.54),
    inset 0 0 34px rgba(92, 201, 255, 0.32);
}

.lens-star-pulse,
.lens-star-point,
.lens-star-grid {
  position: absolute;
  inset: 0;
  border-radius: inherit;
}

.lens-star-pulse {
  inset: 18px;
  border: 1px solid rgba(132, 220, 255, 0.62);
  box-shadow: 0 0 18px rgba(93, 200, 255, 0.76);
}

.lens-star-point {
  inset: 48px;
  background: #ffffff;
  box-shadow:
    0 0 12px #ffffff,
    0 0 32px rgba(88, 194, 255, 1),
    0 0 70px rgba(54, 144, 255, 0.92);
}

.lens-star-grid {
  background-image:
    linear-gradient(rgba(132, 213, 255, 0.16) 1px, transparent 1px),
    linear-gradient(90deg, rgba(132, 213, 255, 0.16) 1px, transparent 1px);
  background-size: 18px 18px;
  mask-image: radial-gradient(circle, #000 0 48%, transparent 72%);
}

.lens-confidence {
  position: absolute;
  z-index: 5;
  top: 126px;
  right: 8%;
  display: grid;
  gap: 2px;
}

.lens-confidence-score {
  color: #75ff95;
  font-size: 26px;
  line-height: 1;
  text-shadow: 0 0 18px rgba(117, 255, 149, 0.68);
}

.lens-confidence-label {
  color: #73ed8d;
  font-size: 12px;
}

.lens-context-meter {
  position: absolute;
  z-index: 5;
  left: 50%;
  bottom: 78px;
  width: 270px;
  text-align: center;
  transform: translateX(-50%);
}

.lens-context-visible {
  display: block;
  margin-top: 5px;
  color: #82f19e;
  font-size: 14px;
}

.lens-context-ticks {
  --context-fill: 60%;
  display: grid;
  grid-template-columns: repeat(20, 1fr);
  gap: 4px;
  margin-top: 10px;
}

.lens-context-tick {
  height: 16px;
  border-radius: 999px;
  background: rgba(131, 160, 184, 0.38);
  box-shadow: inset 0 0 8px rgba(255, 255, 255, 0.08);
}

.lens-context-tick-filled {
  background: linear-gradient(180deg, rgba(134, 238, 166, 0.92), rgba(82, 178, 255, 0.52));
  box-shadow: 0 0 12px rgba(109, 218, 181, 0.48);
}

.lens-context-clip {
  margin-top: 8px;
  color: #a8bfd2;
  font-size: 12px;
}

.lens-evidence-dock {
  position: absolute;
  z-index: 6;
  left: 50%;
  bottom: 18px;
  display: flex;
  align-items: center;
  gap: 10px;
  max-width: 70%;
  padding: 10px 15px;
  border: 1px solid rgba(118, 237, 143, 0.46);
  border-radius: 24px;
  transform: translateX(-50%);
  background: linear-gradient(180deg, rgba(10, 45, 31, 0.78), rgba(4, 21, 18, 0.9));
  box-shadow:
    0 0 28px rgba(89, 230, 142, 0.24),
    inset 0 0 18px rgba(109, 235, 151, 0.1);
}

.lens-evidence-node {
  position: relative;
  max-width: 150px;
  overflow: hidden;
  color: #c9f7d8;
  font-size: 11px;
  font-weight: 700;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.lens-evidence-node + .lens-evidence-node {
  padding-left: 18px;
}

.lens-evidence-node + .lens-evidence-node::before {
  content: ">";
  position: absolute;
  left: 3px;
  color: #79e497;
}

@media (max-width: 1180px) {
  .constellation-lens,
  .constellation-core,
  .lens-system {
    min-height: 680px;
  }

  .lens-current-message {
    left: 8%;
  }

  .lens-confidence {
    right: 5%;
  }
}

@media (max-width: 760px) {
  .constellation-lens,
  .constellation-core,
  .lens-system {
    min-height: 760px;
  }

  .lens-current-message,
  .lens-role-stream,
  .lens-confidence,
  .lens-context-meter,
  .lens-evidence-dock {
    position: relative;
    left: auto;
    right: auto;
    top: auto;
    bottom: auto;
    width: auto;
    max-width: none;
    transform: none;
  }

  .lens-system {
    display: grid;
    gap: 16px;
    align-content: end;
    padding: 260px 16px 18px;
  }

  .lens-event-node {
    transform:
      rotate(var(--orbit-angle))
      translateX(116px)
      rotate(calc(-1 * var(--orbit-angle)));
  }
}
`;
}
