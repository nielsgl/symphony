import { renderConstellationCoreStyles } from './apple-constellation-core-styles';
import { renderConstellationGravityStyles } from './apple-constellation-gravity-styles';
import { renderConstellationInterlockStyles } from './apple-constellation-interlock-styles';

export function renderAppleConstellationStyles(): string {
  return `
.legacy-dashboard-panels {
  display: none;
}

body.constellation-more-open .legacy-dashboard-panels {
  display: grid;
}

.apple-constellation {
  position: relative;
  z-index: 1;
  min-height: calc(100svh - 92px);
  padding: 20px 26px 14px;
  color: #eaf6ff;
  background:
    radial-gradient(circle at 11% 9%, rgba(73, 160, 255, 0.12), transparent 0 22%, transparent 38%),
    radial-gradient(circle at 50% 40%, rgba(54, 142, 255, 0.2), transparent 32%),
    linear-gradient(180deg, #06111a 0%, #02070b 100%);
  overflow: hidden;
}

.constellation-stage {
  min-height: min(620px, calc(100svh - 372px));
  display: grid;
  grid-template-columns: minmax(260px, 330px) minmax(560px, 1fr) minmax(300px, 350px);
  gap: 24px;
  align-items: stretch;
}

.constellation-section-label {
  color: #9db4c8;
  font-size: 11px;
  font-weight: 800;
  letter-spacing: 0.16em;
  text-transform: uppercase;
}

.constellation-section-subtitle {
  margin: 4px 0 12px;
  color: #b7c7d5;
}

.constellation-gravity,
.constellation-lens,
.constellation-interlocks,
.constellation-evidence,
.constellation-footer {
  min-width: 0;
}

.constellation-core,
.constellation-issue-list,
.constellation-interlock-list,
.constellation-evidence-path,
.constellation-actions {
  min-height: 120px;
}

.constellation-footer {
  margin-top: 12px;
  min-height: 54px;
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  gap: 1px;
  border: 1px solid rgba(130, 180, 220, 0.2);
  border-radius: 18px;
  overflow: hidden;
  background: rgba(5, 16, 24, 0.78);
}

.constellation-footer div {
  padding: 11px 18px;
  color: #86a0b4;
}

.constellation-footer strong {
  display: block;
  margin-top: 3px;
  color: #dff2ff;
}

@media (max-width: 1180px) {
  .constellation-stage {
    grid-template-columns: 1fr;
  }

  .constellation-footer {
    grid-template-columns: 1fr 1fr;
  }
}

${renderConstellationGravityStyles()}
${renderConstellationCoreStyles()}
${renderConstellationInterlockStyles()}
`;
}
