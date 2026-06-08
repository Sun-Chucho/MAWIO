import Link from "next/link";
import { CheckCircle2 } from "lucide-react";
import { updateWebsiteBookingPaymentServer } from "@/app/lib/website-bookings-server";

export default async function PaymentReturnPage({
  searchParams,
}: {
  searchParams: Promise<{ booking?: string; ref?: string; orderReference?: string }>;
}) {
  const params = await searchParams;
  const bookingReference = params.booking ?? "";
  const orderReference = params.orderReference ?? params.ref ?? "";
  let paymentUpdated = false;

  if (bookingReference) {
    paymentUpdated = await updateWebsiteBookingPaymentServer(bookingReference, "paid", "PAID_BY_RETURN");
  }

  return (
    <main className="flex min-h-[100dvh] items-center justify-center bg-[#f8f6f3] px-4 py-12 text-black">
      <section className="w-full max-w-xl rounded-sm border border-black/10 bg-white p-6 shadow-[0_18px_45px_rgba(0,0,0,0.10)] sm:p-8">
        <CheckCircle2 className="h-12 w-12 text-orange-500" />
        <p className="mt-5 text-[11px] font-black uppercase tracking-[0.22em] text-orange-600">Payment Submitted</p>
        <h1 className="mt-3 font-headline text-4xl leading-tight">Thank you for booking MAWIO</h1>
        <p className="mt-4 text-sm leading-7 text-black/65">
          Your payment has been sent to the secure payment gateway.
          {paymentUpdated ? " Reception has been updated with the paid status." : " Reception can confirm the final transaction state from the N-Genius sandbox portal."}
        </p>
        {bookingReference ? (
          <p className="mt-5 rounded-sm border border-orange-200 bg-orange-50 px-4 py-3 text-sm font-bold text-orange-800">
            Booking reference: {bookingReference}
          </p>
        ) : null}
        {orderReference ? (
          <p className="mt-3 rounded-sm border border-black/10 bg-black/[0.03] px-4 py-3 text-xs font-bold text-black/65">
            Payment order: {orderReference}
          </p>
        ) : null}
        <Link
          href="/"
          className="mt-6 inline-flex items-center justify-center bg-black px-5 py-3 text-xs font-black uppercase tracking-[0.16em] text-white transition hover:bg-orange-500"
        >
          Back To Hotel
        </Link>
      </section>
    </main>
  );
}
