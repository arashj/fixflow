import { createSlice, PayloadAction } from '@reduxjs/toolkit';
import type { User } from './types';

const KEY = 'fixflow.auth';

interface AuthState {
  token: string | null;
  user: User | null;
}

function load(): AuthState {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return JSON.parse(raw);
  } catch {
    /* storage unavailable or corrupted: start signed out */
  }
  return { token: null, user: null };
}

function save(s: AuthState) {
  try {
    if (s.token) localStorage.setItem(KEY, JSON.stringify(s));
    else localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}

const authSlice = createSlice({
  name: 'auth',
  initialState: load(),
  reducers: {
    signedIn(_state, action: PayloadAction<{ token: string; user: User }>) {
      save(action.payload);
      return action.payload;
    },
    signedOut() {
      save({ token: null, user: null });
      return { token: null, user: null };
    },
  },
});

export const { signedIn, signedOut } = authSlice.actions;
export default authSlice.reducer;
