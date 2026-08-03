import React, { useState, useRef, useEffect } from 'react';
import { useAuth } from '../lib/auth-context';
import { ApiError } from '../lib/api-client';
import { Camera, Upload, User as UserIcon, X, Sparkles, ArrowRight } from 'lucide-react';

export const ProfileSetupView: React.FC = () => {
  const { user, updateProfile, logout } = useAuth();

  const [avatarUrl, setAvatarUrl] = useState('');
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [mobileNumber, setMobileNumber] = useState('');
  const [username, setUsername] = useState('');

  const [isCameraActive, setIsCameraActive] = useState(false);
  const [cameraStream, setCameraStream] = useState<MediaStream | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');

  useEffect(() => {
    if (user?.photoURL) setAvatarUrl(user.photoURL);
    if (user?.firstName) setFirstName(user.firstName);
    if (user?.lastName) setLastName(user.lastName);
  }, [user]);

  useEffect(() => {
    return () => {
      if (cameraStream) cameraStream.getTracks().forEach(t => t.stop());
    };
  }, [cameraStream]);

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      setErrorMsg('Please select a valid image file.');
      return;
    }
    const reader = new FileReader();
    reader.onload = (event) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = 256;
        canvas.height = 256;
        const ctx = canvas.getContext('2d');
        if (ctx) {
          const minDim = Math.min(img.width, img.height);
          const sx = (img.width - minDim) / 2;
          const sy = (img.height - minDim) / 2;
          ctx.drawImage(img, sx, sy, minDim, minDim, 0, 0, 256, 256);
          setAvatarUrl(canvas.toDataURL('image/jpeg', 0.85));
        }
      };
      img.src = event.target?.result as string;
    };
    reader.readAsDataURL(file);
  };

  const handleStartCamera = async () => {
    setErrorMsg('');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 640 }, height: { ideal: 640 }, facingMode: 'user' } });
      setCameraStream(stream);
      setIsCameraActive(true);
      setTimeout(() => {
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          videoRef.current.play().catch(console.error);
        }
      }, 100);
    } catch (err) {
      console.error('Camera access error:', err);
      setErrorMsg('Could not access camera — try uploading a photo instead.');
    }
  };

  const handleStopCamera = () => {
    if (cameraStream) {
      cameraStream.getTracks().forEach(t => t.stop());
      setCameraStream(null);
    }
    setIsCameraActive(false);
  };

  const handleCaptureSnapshot = () => {
    if (!videoRef.current) return;
    const video = videoRef.current;
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 256;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      const minDim = Math.min(video.videoWidth || 256, video.videoHeight || 256);
      const sx = ((video.videoWidth || 256) - minDim) / 2;
      const sy = ((video.videoHeight || 256) - minDim) / 2;
      ctx.translate(256, 0);
      ctx.scale(-1, 1);
      ctx.drawImage(video, sx, sy, minDim, minDim, 0, 0, 256, 256);
      setAvatarUrl(canvas.toDataURL('image/jpeg', 0.88));
      handleStopCamera();
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg('');

    if (!firstName.trim() || !lastName.trim()) {
      setErrorMsg('Enter your first and last name.');
      return;
    }
    if (!mobileNumber.trim() || mobileNumber.trim().length < 8) {
      setErrorMsg('Enter a valid mobile number with country code.');
      return;
    }
    if (!username.trim() || username.trim().length < 3) {
      setErrorMsg('Choose a username (at least 3 characters).');
      return;
    }
    if (!/^[a-z0-9_]+$/i.test(username.trim())) {
      setErrorMsg('Username can only contain letters, numbers and underscores.');
      return;
    }

    setLoading(true);
    try {
      await updateProfile({
        firstName: firstName.trim(),
        lastName: lastName.trim(),
        phoneNumber: mobileNumber.trim(),
        username: username.trim().toLowerCase(),
        ...(avatarUrl ? { avatarUrl } : {}),
      });
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setErrorMsg('That username is already taken — try another.');
      } else {
        setErrorMsg('Something went wrong — please try again.');
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-bg text-text flex flex-col items-center justify-center p-5 font-sans">
      <div className="w-full max-w-sm space-y-6">

        <div className="text-center space-y-1.5">
          <div className="w-11 h-11 rounded-full bg-accent/10 border border-accent/30 text-accent flex items-center justify-center mx-auto mb-1">
            <Sparkles className="w-5 h-5" />
          </div>
          <h1 className="text-xl font-bold tracking-tight text-text">Complete your profile</h1>
          <p className="text-xs text-text-muted">This is what other players will see at the table.</p>
        </div>

        {errorMsg && (
          <div className="p-3 rounded-xl bg-danger/10 border border-danger/30 text-danger text-sm text-center">
            {errorMsg}
          </div>
        )}

        {isCameraActive && (
          <div className="p-4 bg-surface border border-accent/40 rounded-2xl space-y-3 text-center">
            <div className="flex items-center justify-between text-xs font-medium text-text">
              <span>Take a photo</span>
              <button onClick={handleStopCamera} className="text-text-muted hover:text-text cursor-pointer">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="relative w-40 h-40 mx-auto rounded-full overflow-hidden border-2 border-accent bg-black">
              <video ref={videoRef} autoPlay playsInline className="w-full h-full object-cover transform -scale-x-100" />
            </div>
            <button
              type="button"
              onClick={handleCaptureSnapshot}
              className="w-full h-11 bg-accent hover:bg-accent text-accent-contrast font-semibold rounded-xl text-sm cursor-pointer"
            >
              Capture
            </button>
          </div>
        )}

        {/* Optional avatar */}
        <div className="flex items-center gap-4">
          <div className="w-16 h-16 rounded-full border border-line bg-surface flex items-center justify-center overflow-hidden shrink-0">
            {avatarUrl ? (
              <img src={avatarUrl} alt="Avatar" className="w-full h-full object-cover" />
            ) : (
              <UserIcon className="w-6 h-6 text-text-faint" />
            )}
          </div>
          <div className="flex gap-2 flex-grow">
            <button
              type="button"
              onClick={handleStartCamera}
              className="flex-1 h-10 flex items-center justify-center gap-1.5 rounded-xl bg-surface border border-line text-text text-xs font-medium hover:bg-surface-alt transition cursor-pointer"
            >
              <Camera className="w-3.5 h-3.5" /> Camera
            </button>
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="flex-1 h-10 flex items-center justify-center gap-1.5 rounded-xl bg-surface border border-line text-text text-xs font-medium hover:bg-surface-alt transition cursor-pointer"
            >
              <Upload className="w-3.5 h-3.5" /> Upload
            </button>
          </div>
          <input type="file" ref={fileInputRef} onChange={handleFileUpload} accept="image/*" className="hidden" />
        </div>
        <p className="text-[11px] text-text-faint -mt-4">Photo is optional — you can add one later.</p>

        <form onSubmit={handleSubmit} className="space-y-3">
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-text-muted">First name</label>
            <input
              type="text"
              required
              placeholder="Phil"
              value={firstName}
              onChange={(e) => setFirstName(e.target.value)}
              className="w-full h-12 bg-surface border border-line rounded-xl px-4 text-sm text-text placeholder:text-text-faint focus:border-accent focus:outline-none transition"
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-medium text-text-muted">Last name</label>
            <input
              type="text"
              required
              placeholder="Ivey"
              value={lastName}
              onChange={(e) => setLastName(e.target.value)}
              className="w-full h-12 bg-surface border border-line rounded-xl px-4 text-sm text-text placeholder:text-text-faint focus:border-accent focus:outline-none transition"
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-medium text-text-muted">Mobile number</label>
            <input
              type="tel"
              required
              placeholder="+91 98765 43210"
              value={mobileNumber}
              onChange={(e) => setMobileNumber(e.target.value)}
              className="w-full h-12 bg-surface border border-line rounded-xl px-4 text-sm text-text placeholder:text-text-faint focus:border-accent focus:outline-none transition"
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-medium text-text-muted">Username</label>
            <input
              type="text"
              required
              placeholder="philivey"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              className="w-full h-12 bg-surface border border-line rounded-xl px-4 text-sm text-text placeholder:text-text-faint focus:border-accent focus:outline-none transition"
            />
          </div>

          <button
            type="submit"
            disabled={loading}
            className="w-full h-12 flex items-center justify-center gap-2 rounded-xl bg-accent hover:bg-accent text-accent-contrast font-semibold text-sm active:scale-[0.99] transition disabled:opacity-50 cursor-pointer"
          >
            {loading ? 'Saving…' : 'Continue'} <ArrowRight className="w-4 h-4" />
          </button>
        </form>

        <button
          onClick={() => logout()}
          className="w-full text-center text-xs text-text-faint hover:text-text-muted transition cursor-pointer"
        >
          Sign out
        </button>
      </div>
    </div>
  );
};
