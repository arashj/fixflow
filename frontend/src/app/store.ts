import { configureStore } from '@reduxjs/toolkit';
import { useDispatch, useSelector } from 'react-redux';
import auth, { signedIn, signedOut } from './authSlice';
import { api } from './api';
import type { User } from './types';

export const store = configureStore({
  reducer: { auth, [api.reducerPath]: api.reducer },
  middleware: (gdm) => gdm().concat(api.middleware),
});

/** Switching accounts must never show cached data from the previous one. */
export function signIn(payload: { token: string; user: User }) {
  store.dispatch(api.util.resetApiState());
  store.dispatch(signedIn(payload));
}

export function signOut() {
  store.dispatch(signedOut());
  store.dispatch(api.util.resetApiState());
}

export type RootState = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch;
export const useAppDispatch = useDispatch.withTypes<AppDispatch>();
export const useAppSelector = useSelector.withTypes<RootState>();
