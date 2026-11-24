import React from 'react';
import { AlertTriangle, OctagonAlert } from 'lucide-react';
import type { SafetyState } from '../types/cell';

interface SafetyBannerProps {
  safety: SafetyState;
}

export const SafetyBanner: React.FC<SafetyBannerProps> = ({ safety }) => {
  if (safety.status === 'nominal') {
    return null;
  }

  const isFault = safety.status === 'estop_triggered';

  return (
    <div
      className={`safety-banner ${isFault ? 'fault' : 'warning'}`}
      role={isFault ? 'alert' : 'status'}
    >
      <div className="safety-banner-main">
        <span className="safety-banner-icon" aria-hidden="true">
          {isFault ? <OctagonAlert size={20} /> : <AlertTriangle size={20} />}
        </span>
        <div>
          <p className="safety-banner-title">{safety.summary}</p>
          <p className="safety-banner-text">{safety.operatorGuidance}</p>
        </div>
      </div>
      <span className="safety-banner-meta mono">
        Relevé {safety.lastCheckTimestamp}
      </span>
    </div>
  );
};
