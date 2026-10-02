import React from 'react';

interface EvaluationBarProps {
  evaluation: number;
  mate: number | null;
  turn: 'w' | 'b';
}

export function EvaluationBar({ evaluation, mate, turn }: EvaluationBarProps) {
  // Convert evaluation into a percentage for the bar
  // We use a non-linear scale so large advantages don't completely fill the bar unless mate.
  // eval is typically from -10 to +10. Let's cap at 10.
  let percentage = 50;
  let text = '0.00';

  if (mate !== null) {
      if (mate > 0) { // White mate
          percentage = 100;
          text = `M${Math.abs(mate)}`;
      } else if (mate < 0) { // Black mate
          percentage = 0;
          text = `-M${Math.abs(mate)}`;
      }
  } else {
      // non-linear sigmoid-ish transformation for visual bar
      // 0 -> 50%, +2 -> ~88%, -2 -> ~12%
      percentage = 50 + (50 * (2 / (1 + Math.exp(-0.4 * evaluation)) - 1));
      
      text = evaluation > 0 ? `+${evaluation.toFixed(2)}` : evaluation.toFixed(2);
  }

  // If Black is at the bottom (playerColor === 'b'), we might flip the bar's orientation.
  // Actually, standard is white always at bottom of eval bar, or text relative to the person viewing?
  // Let's just do a simple vertical bar. White is top/bottom based on standard chess UI.
  // Usually White is at the bottom of the bar if White is playing from the bottom.

  return (
    <div className="h-full w-6 bg-[#18181b] flex flex-col justify-end border border-[#27272a] rounded overflow-hidden relative mr-4 shrink-0 transition-all duration-300">
        {/* The Black portion is the top bg, White portion is the inner div filling from bottom */}
        {/* We can do absolute positioning */}
        <div 
          className="absolute bottom-0 w-full bg-white transition-all duration-500 ease-in-out" 
          style={{ height: `${percentage}%` }}
        />
        
        {/* Text evaluation */}
        <div className={`absolute w-full text-center text-[10px] font-bold z-10 py-1 ${percentage > 50 ? 'text-black bottom-0' : 'text-white top-0'}`}>
            {text}
        </div>
    </div>
  );
}
