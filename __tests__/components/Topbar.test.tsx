import { render, screen } from '@testing-library/react';
import TopBar from '../../components/common/TopBar';

jest.mock('next/router', () => ({
   useRouter: () => ({
      pathname: '/',
   }),
}));
jest.mock('../../services/billing', () => ({
   __esModule: true,
   useBillingStatus: () => ({ data: null }),
   useStartCheckout: () => ({ mutate: jest.fn(), isLoading: false }),
}));

describe('TopBar Component', () => {
   it('renders without crashing', async () => {
       render(<TopBar showSettings={jest.fn} showAddModal={jest.fn} />);
       expect(
           await screen.findByText('s33k'),
       ).toBeInTheDocument();
   });
});
