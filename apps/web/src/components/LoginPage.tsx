import React, { useEffect, useState } from 'react';
import { motion, useReducedMotion } from 'motion/react';
import { useAuth } from '../lib/auth-context';
import { ApiError } from '../lib/api-client';
import { Mail, Lock, Spade, Heart, Eye, EyeOff } from 'lucide-react';
import { ChipCardDecoration } from './ChipCardDecoration';
import { BrandLogo } from './BrandLogo';

interface LoginPageProps {
  onBack?: () => void;
}

const REMEMBERED_EMAIL_KEY = 'thk_remembered_email';
const SERIF = "'Playfair Display', Georgia, serif";

// Large-spacing four-suit pattern, tiled at very low opacity — the felt
// texture should only read as intentional up close, never as a graphic.
const SUIT_PATTERN = encodeURIComponent(`
<svg xmlns="http://www.w3.org/2000/svg" width="220" height="220">
  <text x="20" y="45" font-size="34" fill="#D4AF37" font-family="Georgia, serif">&#9824;</text>
  <text x="140" y="95" font-size="34" fill="#D4AF37" font-family="Georgia, serif">&#9829;</text>
  <text x="60" y="150" font-size="34" fill="#D4AF37" font-family="Georgia, serif">&#9830;</text>
  <text x="170" y="200" font-size="34" fill="#D4AF37" font-family="Georgia, serif">&#9827;</text>
</svg>
`.trim());

export const LoginPage: React.FC<LoginPageProps> = ({ onBack }) => {
  const { login, register, loginWithGoogle } = useAuth();
  const prefersReducedMotion = useReducedMotion();
  const [isSignUp, setIsSignUp] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [showForgotNote, setShowForgotNote] = useState(false);
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');

  useEffect(() => {
    const remembered = localStorage.getItem(REMEMBERED_EMAIL_KEY);
    if (remembered) setEmail(remembered);
  }, []);

  const handleGoogleSignIn = () => {
    setErrorMsg('');
    loginWithGoogle();
  };

  const handleEmailAuth = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg('');

    if (!email || !password) {
      setErrorMsg('Enter your email and password.');
      return;
    }
    if (isSignUp && password.length < 8) {
      setErrorMsg('Password must be at least 8 characters.');
      return;
    }

    setLoading(true);
    try {
      if (isSignUp) {
        await register(email, password);
      } else {
        await login(email, password);
      }
      localStorage.setItem(REMEMBERED_EMAIL_KEY, email);
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.status === 409) setErrorMsg('This email is already registered — try signing in.');
        else if (err.status === 401) setErrorMsg('Invalid email or password.');
        else setErrorMsg(err.message || 'Something went wrong.');
      } else {
        setErrorMsg('Something went wrong.');
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="relative min-h-screen bg-bg text-text flex flex-col items-center p-5 pt-10 pb-0 font-sans overflow-hidden">
      {/* Felt suit-pattern texture */}
      <div
        className="absolute inset-0 opacity-[0.05] pointer-events-none"
        style={{
          backgroundImage: `url("data:image/svg+xml,${SUIT_PATTERN}")`,
          backgroundSize: '220px 220px',
        }}
      />
      {/* Vignette */}
      <div
        className="absolute inset-0 pointer-events-none"
        style={{
          background: 'radial-gradient(ellipse 80% 50% at 50% 20%, color-mix(in srgb, var(--color-accent) 5%, transparent), transparent 60%)',
        }}
      />

      <div className="relative w-full max-w-sm space-y-6 flex-1">
        {/* Logo + wordmark */}
        <motion.div
          initial={prefersReducedMotion ? false : { opacity: 0, y: -8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5 }}
          className="flex flex-col items-center gap-4 text-center pt-2"
        >
          <BrandLogo />
          <div>
            <h1 className="text-3xl font-black tracking-tight text-accent" style={{ fontFamily: SERIF }}>
              The House Keeps Score
            </h1>
          </div>
          <div className="flex items-center gap-3 w-full max-w-[220px]">
            <span className="flex-1 h-px bg-gradient-to-r from-transparent via-accent/70 to-accent/70" />
            <Spade className="w-3 h-3 text-accent shrink-0" fill="currentColor" />
            <span className="flex-1 h-px bg-gradient-to-l from-transparent via-accent/70 to-accent/70" />
          </div>
        </motion.div>

        {/* Form */}
        <motion.div
          initial={prefersReducedMotion ? false : { opacity: 0, y: 24 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ type: 'spring', stiffness: 260, damping: 24, delay: 0.1 }}
          className="space-y-5"
        >
          <div className="text-center">
            <h2 className="text-xl font-bold text-text">{isSignUp ? 'Create your account' : 'Welcome back'}</h2>
            <p className="text-sm text-text-muted mt-1">{isSignUp ? 'Join your private table' : 'Track the game. Keep it fair.'}</p>
          </div>

          {errorMsg && (
            <div className="p-3 rounded-xl bg-danger/10 border border-danger/30 text-danger text-sm text-center">
              {errorMsg}
            </div>
          )}

          <form onSubmit={handleEmailAuth} className="space-y-4">
            <div className="relative">
              <Mail className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-accent" />
              <input
                type="email"
                required
                autoComplete="email"
                placeholder="Email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full h-14 bg-transparent border border-line rounded-2xl pl-12 pr-4 text-sm text-text placeholder:text-text-muted focus:border-accent focus:outline-none transition"
              />
            </div>

            <div className="relative">
              <Lock className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-accent" />
              <input
                type={showPassword ? 'text' : 'password'}
                required
                autoComplete={isSignUp ? 'new-password' : 'current-password'}
                placeholder="Password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full h-14 bg-transparent border border-line rounded-2xl pl-12 pr-11 text-sm text-text placeholder:text-text-muted focus:border-accent focus:outline-none transition"
              />
              <button
                type="button"
                onClick={() => setShowPassword((v) => !v)}
                className="absolute right-4 top-1/2 -translate-y-1/2 text-accent/70 hover:text-accent cursor-pointer"
                tabIndex={-1}
              >
                {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>

            {!isSignUp && (
              <div className="flex justify-end -mt-1.5">
                <button
                  type="button"
                  onClick={() => setShowForgotNote((v) => !v)}
                  className="text-xs text-accent hover:opacity-80 transition cursor-pointer"
                >
                  Forgot Password?
                </button>
              </div>
            )}

            {showForgotNote && !isSignUp && (
              <p className="text-[11px] text-text-muted bg-surface border border-line rounded-lg px-3 py-2">
                Password reset isn't available yet — ask your club owner or admin for help regaining access.
              </p>
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full h-14 flex items-center justify-center rounded-2xl text-accent-contrast font-bold text-base active:scale-[0.99] transition disabled:opacity-50 cursor-pointer shadow-lg shadow-black/30"
              style={{ background: 'linear-gradient(135deg, color-mix(in srgb, var(--color-accent) 70%, white), var(--color-accent) 55%, color-mix(in srgb, var(--color-accent) 80%, black))' }}
            >
              {loading ? 'Please wait…' : isSignUp ? 'Create account' : 'Sign In'}
            </button>
          </form>

          <div className="flex items-center gap-3">
            <span className="flex-1 h-px bg-line" />
            <span className="text-[11px] text-text-muted">or</span>
            <span className="flex-1 h-px bg-line" />
          </div>

          <button
            onClick={handleGoogleSignIn}
            disabled={loading}
            className="w-full h-14 flex items-center justify-center gap-3 rounded-2xl border border-line text-text font-medium text-sm hover:border-accent/60 active:scale-[0.99] transition disabled:opacity-50 cursor-pointer"
          >
            <svg className="w-4 h-4" viewBox="0 0 24 24">
              <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
              <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
              <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z"/>
              <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z"/>
            </svg>
            Continue with Google
          </button>

          <button
            type="button"
            onClick={() => { setIsSignUp(!isSignUp); setErrorMsg(''); }}
            className="w-full text-center text-xs text-text-muted hover:text-text transition cursor-pointer pt-1"
          >
            {isSignUp ? 'Already have an account? ' : 'New here? '}
            <span className="text-accent font-medium">{isSignUp ? 'Sign in' : 'Create an account'}</span>
          </button>
        </motion.div>

        {onBack && (
          <button
            onClick={onBack}
            className="w-full text-center text-xs text-text-faint hover:text-text-muted transition cursor-pointer"
          >
            ← Back
          </button>
        )}
      </div>

      {/* Chips + cards, bleeding off the bottom edge — real rendered assets */}
      <ChipCardDecoration variant="hero" />
    </div>
  );
};
