import { lazy, Suspense, useEffect } from 'react';
import { Navigate, Route, Routes, type Location } from 'react-router-dom';
import { MainLayout } from '@/components/layout/MainLayout';
import { ErrorBoundary } from '@/components/common/ErrorBoundary';
import { NotificationContainer } from '@/components/common/NotificationContainer';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { LoginPage } from '@/pages/LoginPage';
import { useAuthStore } from '@/stores/auth';
import { useThemeStore } from '@/stores/theme';

const UsagePage = lazy(() => import('@/features/usage/UsagePage'));
const RequestsPage = lazy(() => import('@/features/requests/RequestsPage'));
const QuotaPage = lazy(() => import('@/features/quota/QuotaPage'));
const QuotaHistoryPage = lazy(() => import('@/features/quotaHistory/QuotaHistoryPage'));

function PageFallback() {
  return (
    <div style={{ display: 'grid', placeItems: 'center', minHeight: '40vh' }}>
      <LoadingSpinner />
    </div>
  );
}

const renderRoutes = (location: Location) => (
  <ErrorBoundary resetKey={location.pathname}>
    <Suspense fallback={<PageFallback />}>
      <Routes location={location}>
      <Route path="/usage" element={<UsagePage />} />
      <Route path="/requests" element={<RequestsPage />} />
      <Route path="/quota" element={<QuotaPage />} />
      <Route path="/quota-history" element={<QuotaHistoryPage />} />
      <Route path="*" element={<Navigate to="/usage" replace />} />
      </Routes>
    </Suspense>
  </ErrorBoundary>
);

export function App() {
  const managementKey = useAuthStore((state) => state.managementKey);
  const initializeTheme = useThemeStore((state) => state.initializeTheme);

  useEffect(() => initializeTheme(), [initializeTheme]);

  return (
    <>
      {managementKey ? <MainLayout renderRoutes={renderRoutes} /> : <LoginPage />}
      <NotificationContainer />
    </>
  );
}
