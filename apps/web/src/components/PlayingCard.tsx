import React from 'react';
import { Crown } from 'lucide-react';
import { motion, type Variants } from 'motion/react';
import { Card } from '../types';

interface PlayingCardProps {
  card?: Card | null;
  hidden?: boolean;
  size?: 'sm' | 'md' | 'lg' | 'xl';
  isFolded?: boolean;
  variant?: 'community' | 'player';
  delayIndex?: number;
}

export const PlayingCard: React.FC<PlayingCardProps> = React.memo(({
  card,
  hidden = false,
  size = 'md',
  isFolded = false,
  variant = 'community',
  delayIndex = 0
}) => {
  const sizeClasses = {
    sm: 'w-10 h-14 text-xs p-1 rounded-md shadow-md',
    md: 'w-14 h-20 text-sm p-1.5 rounded-lg shadow-lg',
    lg: 'w-20 h-28 text-base p-2 rounded-xl shadow-2xl',
    xl: 'w-32 h-44 text-xl p-3.5 rounded-2xl shadow-2xl'
  };

  const animationVariants: Variants = {
    initial: { scale: 0.3, y: -40, opacity: 0, rotate: -10 },
    animate: {
      scale: isFolded ? 0.9 : 1,
      y: 0,
      opacity: isFolded ? 0.35 : 1,
      rotate: 0,
      transition: {
        type: 'spring',
        stiffness: 260,
        damping: 20,
        delay: delayIndex * 0.08
      }
    },
    exit: { scale: 0.5, y: 30, opacity: 0 }
  };

  if (hidden) {
    return (
      <motion.div
        id="playing-card-hidden"
        variants={animationVariants}
        initial="initial"
        animate="animate"
        exit="exit"
        className={`${sizeClasses[size]} bg-bg border border-accent-2/40 flex flex-col items-center justify-center relative overflow-hidden select-none shadow-2xl`}
      >
        <div className="absolute inset-1 border border-accent-2/20 rounded-lg flex items-center justify-center">
          <div className="w-full h-full opacity-20 bg-[radial-gradient(var(--color-accent-2)_1px,transparent_1px)] [background-size:8px_8px]"></div>
        </div>
        <Crown className="w-5 h-5 text-accent-2/60 relative z-10" />
      </motion.div>
    );
  }

  if (!card) return null;

  if (variant === 'player') {
    return (
      <motion.div
        id={`playing-card-${card.id}`}
        variants={animationVariants}
        initial="initial"
        animate="animate"
        exit="exit"
        whileHover={!isFolded ? { scale: 1.05, y: -4 } : {}}
        className={`${sizeClasses[size]} bg-bg border border-accent-2/70 text-accent-2 flex flex-col justify-between relative overflow-hidden font-mono shadow-2xl ${isFolded ? 'grayscale' : ''}`}
      >
        <div className="flex justify-between items-start leading-none">
          <span className="font-extrabold">{card.rank}</span>
          <span className="text-xs">{card.suit}</span>
        </div>
        <div className="self-center text-2xl font-black">{card.suit}</div>
        <div className="flex justify-between items-end leading-none rotate-180">
          <span className="font-extrabold">{card.rank}</span>
          <span className="text-xs">{card.suit}</span>
        </div>
      </motion.div>
    );
  }

  return (
    <motion.div
      id={`playing-card-${card.id}`}
      variants={animationVariants}
      initial="initial"
      animate="animate"
      exit="exit"
      whileHover={!isFolded ? { scale: 1.05, y: -3 } : {}}
      className={`${sizeClasses[size]} bg-stone-100 border border-stone-300 ${card.isRed ? 'text-rose-700' : 'text-zinc-900'} flex flex-col justify-between relative overflow-hidden font-sans shadow-xl ${isFolded ? 'grayscale opacity-40' : ''}`}
    >
      <div className="flex justify-between items-start leading-none font-bold">
        <span>{card.rank}</span>
        <span className="text-xs">{card.suit}</span>
      </div>
      <div className="self-center text-2xl font-bold">{card.suit}</div>
      <div className="flex justify-between items-end leading-none font-bold rotate-180">
        <span>{card.rank}</span>
        <span className="text-xs">{card.suit}</span>
      </div>
    </motion.div>
  );
});
