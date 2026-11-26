import React from 'react';
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
        <span className="safety-alarm-code" aria-hidden="true">
          {isFault ? 'ALM-AU-13850' : 'ALM-ISO-15066'}
        </span>
        <div>
          <p className="safety-banner-title">{safety.summary}</p>
          <p className="safety-banner-text">{safety.operatorGuidance}</p>
        </div>
      </div>
      <span className="safety-banner-meta mono">HORODATAGE {safety.lastCheckTimestamp}</span>
    </div>
  );
};
