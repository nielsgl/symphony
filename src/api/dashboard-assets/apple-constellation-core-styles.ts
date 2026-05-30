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
  overflow: hidden;
  border-radius: 999px;
  isolation: isolate;
  perspective: 900px;
  background:
    radial-gradient(circle at 50% 52%, rgba(255, 255, 255, 0.82) 0 1px, transparent 2px),
    radial-gradient(circle at 50% 52%, rgba(44, 184, 255, 0.34) 0 7%, transparent 14%),
    radial-gradient(circle at 50% 52%, rgba(44, 125, 255, 0.22) 0 26%, transparent 48%),
    radial-gradient(circle at 48% 50%, rgba(119, 220, 255, 0.12), transparent 0 44%, transparent 60%),
    radial-gradient(circle at 50% 52%, rgba(2, 8, 18, 0) 0 56%, rgba(2, 8, 18, 0.86) 74%, rgba(2, 8, 18, 0.98) 100%),
    linear-gradient(135deg, rgba(3, 13, 24, 0.94), rgba(2, 8, 15, 0.54));
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
  animation: lens-plane-spin 32s linear infinite reverse;
}

.lens-depth-field,
.lens-orbit-tracks {
  position: absolute;
  inset: 0;
  z-index: 0;
  border-radius: inherit;
  pointer-events: none;
}

.lens-depth-field {
  opacity: 0.95;
  transform: translateZ(-80px);
}

.lens-depth-plane {
  position: absolute;
  inset: 0;
  border-radius: inherit;
  background-repeat: repeat;
  mix-blend-mode: screen;
}

.lens-depth-plane-back {
  opacity: 0.48;
  background-image:
    radial-gradient(circle at 12% 18%, rgba(154, 217, 255, 0.62) 0 1px, transparent 1.6px),
    radial-gradient(circle at 68% 28%, rgba(111, 191, 255, 0.42) 0 1px, transparent 1.7px),
    radial-gradient(circle at 34% 72%, rgba(255, 255, 255, 0.46) 0 1px, transparent 1.8px);
  background-size: 152px 132px, 208px 186px, 176px 214px;
  animation: lens-star-drift 48s linear infinite;
}

.lens-depth-plane-mid {
  inset: 34px;
  opacity: 0.64;
  background-image:
    radial-gradient(circle at 20% 22%, rgba(104, 201, 255, 0.76) 0 1px, transparent 1.9px),
    radial-gradient(circle at 62% 66%, rgba(185, 237, 255, 0.58) 0 1px, transparent 2px),
    radial-gradient(circle at 82% 38%, rgba(123, 130, 255, 0.44) 0 1px, transparent 1.8px);
  background-size: 132px 148px, 190px 160px, 216px 190px;
  animation: lens-star-drift 34s linear infinite reverse;
}

.lens-depth-plane-front {
  inset: 86px;
  opacity: 0.46;
  background-image:
    radial-gradient(circle at 30% 30%, rgba(255, 255, 255, 0.88) 0 1px, transparent 2.2px),
    radial-gradient(circle at 76% 64%, rgba(90, 214, 255, 0.7) 0 1px, transparent 2px);
  background-size: 96px 104px, 142px 136px;
  filter: blur(0.2px);
  animation: lens-star-drift 24s linear infinite;
}

.lens-orbit-tracks {
  left: 50%;
  top: 52%;
  width: min(640px, 93%);
  height: min(640px, 93%);
  inset: auto;
  transform: translate(-50%, -50%) rotateX(58deg) rotateZ(-18deg);
  transform-style: preserve-3d;
}

.lens-orbit-track {
  position: absolute;
  left: 50%;
  top: 50%;
  border-radius: 999px;
  border: 1px solid rgba(92, 190, 255, 0.32);
  transform: translate(-50%, -50%);
  box-shadow:
    0 0 22px rgba(72, 169, 255, 0.28),
    inset 0 0 18px rgba(91, 202, 255, 0.08);
}

.lens-orbit-track-alpha {
  width: 92%;
  height: 92%;
  animation: lens-orbit-glow 8s ease-in-out infinite;
}

.lens-orbit-track-beta {
  width: 72%;
  height: 52%;
  border-color: rgba(121, 219, 255, 0.26);
  transform: translate(-50%, -50%) rotateZ(24deg);
  animation: lens-orbit-glow 10s ease-in-out infinite reverse;
}

.lens-orbit-track-gamma {
  width: 54%;
  height: 79%;
  border-color: rgba(130, 126, 255, 0.24);
  transform: translate(-50%, -50%) rotateZ(-42deg);
}

.lens-orbit-track-delta {
  width: 36%;
  height: 36%;
  border-color: rgba(118, 237, 143, 0.3);
  border-style: dashed;
  animation: lens-orbit-glow 7s ease-in-out infinite;
}

.lens-ring {
  position: absolute;
  z-index: 1;
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
  animation: lens-ring-precession 42s linear infinite;
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
  animation: lens-ring-precession 26s linear infinite reverse;
}

.lens-ring-inner {
  --lens-size: min(200px, 34%);
  border: 1px solid rgba(121, 205, 255, 0.62);
  animation: lens-energy-breathe 5.8s ease-in-out infinite;
  box-shadow:
    0 0 24px rgba(68, 163, 255, 0.78),
    inset 0 0 26px rgba(68, 163, 255, 0.34);
}

.lens-focus-pill {
  position: absolute;
  z-index: 9;
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
  z-index: 8;
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
  z-index: 8;
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
  z-index: 4;
  left: 50%;
  top: 52%;
  width: 1px;
  height: 1px;
  transform-style: preserve-3d;
}

.lens-event-node {
  --orbit-angle: 0deg;
  --orbit-counter-angle: 0deg;
  --orbit-radius: 168px;
  --orbit-speed: 26s;
  --orbit-delay: 0s;
  --orbit-scale: 1;
  position: absolute;
  left: 0;
  top: 0;
  width: 1px;
  height: 1px;
  transform: rotate(var(--orbit-angle));
  transform-origin: 0 0;
  transform-style: preserve-3d;
}

.lens-event-path {
  position: absolute;
  left: 0;
  top: 0;
  width: 1px;
  height: 1px;
  animation: lens-event-orbit var(--orbit-speed) linear infinite;
  animation-delay: var(--orbit-delay);
  transform-origin: 0 0;
  transform-style: preserve-3d;
}

.lens-event-body {
  position: absolute;
  left: 0;
  top: 0;
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 150px;
  animation: lens-event-counter var(--orbit-speed) linear infinite;
  animation-delay: var(--orbit-delay);
  transform-origin: 0 0;
}

.lens-event-bead {
  flex: 0 0 auto;
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
  max-width: 112px;
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
  animation: lens-core-float 7.2s ease-in-out infinite;
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
  animation: lens-pulse-wave 3.8s ease-in-out infinite;
}

.lens-star-point {
  inset: 48px;
  background: #ffffff;
  box-shadow:
    0 0 12px #ffffff,
    0 0 32px rgba(88, 194, 255, 1),
    0 0 70px rgba(54, 144, 255, 0.92);
  animation: lens-energy-breathe 2.8s ease-in-out infinite;
}

.lens-star-grid {
  background-image:
    linear-gradient(rgba(132, 213, 255, 0.16) 1px, transparent 1px),
    linear-gradient(90deg, rgba(132, 213, 255, 0.16) 1px, transparent 1px);
  background-size: 18px 18px;
  mask-image: radial-gradient(circle, #000 0 48%, transparent 72%);
  animation: lens-grid-drift 14s linear infinite;
}

.lens-confidence {
  position: absolute;
  z-index: 8;
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
  z-index: 8;
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
  z-index: 8;
  left: 50%;
  bottom: 14px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 16px;
  width: min(360px, 58%);
  height: 26px;
  padding: 0 22px;
  border: 1px solid rgba(118, 237, 143, 0.22);
  border-radius: 999px;
  transform: translateX(-50%);
  background:
    repeating-linear-gradient(90deg, rgba(118, 237, 143, 0.32) 0 7px, transparent 7px 16px),
    linear-gradient(180deg, rgba(10, 45, 31, 0.5), rgba(4, 21, 18, 0.64));
  box-shadow:
    0 0 22px rgba(89, 230, 142, 0.18),
    inset 0 0 18px rgba(109, 235, 151, 0.1);
}

.lens-evidence-node {
  position: relative;
  width: 8px;
  height: 8px;
  flex: 0 0 8px;
  overflow: visible;
  border-radius: 999px;
  color: transparent;
  font-size: 0;
  background: #9dffaf;
  box-shadow:
    0 0 0 4px rgba(118, 237, 143, 0.1),
    0 0 14px rgba(118, 237, 143, 0.72);
}

.lens-evidence-node + .lens-evidence-node {
  padding-left: 0;
}

.lens-evidence-node + .lens-evidence-node::before {
  content: "";
  position: absolute;
  right: calc(100% + 4px);
  top: 50%;
  width: 8px;
  height: 1px;
  transform: translateY(-50%);
  background: rgba(121, 228, 151, 0.58);
  box-shadow: 0 0 10px rgba(121, 228, 151, 0.52);
}

@keyframes lens-star-drift {
  from {
    background-position: 0 0, 0 0, 0 0;
  }
  to {
    background-position: 152px -132px, -208px 186px, 176px 214px;
  }
}

@keyframes lens-plane-spin {
  from {
    transform: rotate(0deg);
  }
  to {
    transform: rotate(360deg);
  }
}

@keyframes lens-ring-precession {
  from {
    transform: translate(-50%, -50%) rotate(0deg);
  }
  to {
    transform: translate(-50%, -50%) rotate(360deg);
  }
}

@keyframes lens-orbit-glow {
  0%,
  100% {
    opacity: 0.58;
    filter: drop-shadow(0 0 4px rgba(92, 190, 255, 0.22));
  }
  50% {
    opacity: 0.95;
    filter: drop-shadow(0 0 12px rgba(92, 190, 255, 0.44));
  }
}

@keyframes lens-event-orbit {
  from {
    transform: rotate(0deg);
  }
  to {
    transform: rotate(360deg);
  }
}

@keyframes lens-event-counter {
  from {
    transform: translateX(var(--orbit-radius)) rotate(var(--orbit-counter-angle)) scale(var(--orbit-scale));
  }
  to {
    transform: translateX(var(--orbit-radius)) rotate(calc(var(--orbit-counter-angle) - 360deg)) scale(var(--orbit-scale));
  }
}

@keyframes lens-core-float {
  0%,
  100% {
    transform: translate(-50%, -50%) translate3d(0, 0, 0);
  }
  50% {
    transform: translate(-50%, -50%) translate3d(0, -7px, 20px);
  }
}

@keyframes lens-pulse-wave {
  0%,
  100% {
    opacity: 0.42;
    transform: scale(0.86);
  }
  50% {
    opacity: 0.94;
    transform: scale(1.1);
  }
}

@keyframes lens-energy-breathe {
  0%,
  100% {
    opacity: 0.78;
    filter: saturate(1);
  }
  50% {
    opacity: 1;
    filter: saturate(1.35);
  }
}

@keyframes lens-grid-drift {
  from {
    background-position: 0 0, 0 0;
  }
  to {
    background-position: 18px 18px, -18px 18px;
  }
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
    --orbit-radius: 116px !important;
  }
}

@media (prefers-reduced-motion: reduce) {
  .lens-system::after,
  .lens-depth-plane,
  .lens-orbit-track,
  .lens-ring,
  .lens-event-path,
  .lens-event-body,
  .lens-core-star,
  .lens-star-pulse,
  .lens-star-point,
  .lens-star-grid {
    animation: none !important;
  }

  .lens-event-body {
    transform: translateX(var(--orbit-radius)) rotate(var(--orbit-counter-angle)) scale(var(--orbit-scale));
  }
}
`;
}
