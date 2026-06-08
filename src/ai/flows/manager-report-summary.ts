'use server';
/**
 * @fileOverview This file implements a Genkit flow that generates an executive summary
 * for the hotel manager based on daily operational reports.
 *
 * - managerReportSummary - A function that triggers the AI flow to generate the summary.
 * - ManagerReportSummaryInput - The input type for the managerReportSummary function.
 * - ManagerReportSummaryOutput - The return type for the managerReportSummary function.
 */

import { ai } from '@/ai/genkit';
import { z } from 'genkit';

const ManagerReportSummaryInputSchema = z.object({
  dailySalesReport: z
    .string()
    .describe('A summary of daily sales, including revenue, popular items, and payment methods.'),
  shiftReportSummary: z
    .string()
    .describe('A summary of daily shift activities, including staff performance, incidents, and cash reconciliation.'),
  occupancyReport: z
    .string()
    .describe('A report detailing room occupancy, including check-ins, check-outs, available rooms, and booking forecasts.'),
  currentDate: z.string().describe('The current date for which the report is generated (e.g., "YYYY-MM-DD").'),
});

export type ManagerReportSummaryInput = z.infer<typeof ManagerReportSummaryInputSchema>;

const ManagerReportSummaryOutputSchema = z.object({
  executiveSummary: z.string().describe('A concise, executive summary of the hotel\'s daily performance.'),
  keyInsights: z.array(z.string()).describe('A list of critical insights derived from the reports.'),
  anomalies: z.array(z.string()).describe('A list of any anomalies or unusual activities detected.'),
  kpis: z
    .object({
      totalRevenue: z.number().describe('Total revenue for the day.'),
      occupancyRate: z.number().describe('Occupancy rate for the day (e.g., 0.85 for 85%).'),
      popularItem: z.string().optional().describe('The most popular item sold.'),
    })
    .describe('Key performance indicators for the day.'),
});

export type ManagerReportSummaryOutput = z.infer<typeof ManagerReportSummaryOutputSchema>;

const managerReportSummaryPrompt = ai.definePrompt({
  name: 'managerReportSummaryPrompt',
  input: { schema: ManagerReportSummaryInputSchema },
  output: { schema: ManagerReportSummaryOutputSchema },
  prompt: `You are an expert executive assistant for the Hotel Manager of MAWIO. Your task is to analyze the provided daily operational reports and generate a concise executive summary, highlighting critical insights, anomalies, and key performance indicators. The manager needs to quickly understand the hotel's performance without deep diving into raw data.

Focus on the most important information that a hotel manager needs to know. Ensure the tone is professional and direct.

Today's Date: {{{currentDate}}}

Daily Sales Report:
{{{dailySalesReport}}}

Shift Report Summary:
{{{shiftReportSummary}}}

Occupancy Report:
{{{occupancyReport}}}

Based on these reports, provide an executive summary, critical insights, anomalies, and key performance indicators in the specified JSON format.`,
});

const managerReportSummaryFlow = ai.defineFlow(
  {
    name: 'managerReportSummaryFlow',
    inputSchema: ManagerReportSummaryInputSchema,
    outputSchema: ManagerReportSummaryOutputSchema,
  },
  async (input) => {
    const { output } = await managerReportSummaryPrompt(input);
    return output!;
  },
);

export async function managerReportSummary(input: ManagerReportSummaryInput): Promise<ManagerReportSummaryOutput> {
  return managerReportSummaryFlow(input);
}
