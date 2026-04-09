async function main(): Promise<void> {
  const botUrl = process.env.BOT_INTERNAL_URL;
  const secret = process.env.REMINDER_SECRET;

  if (!botUrl || !secret) {
    // eslint-disable-next-line no-console
    console.error("BOT_INTERNAL_URL and REMINDER_SECRET are required");
    process.exit(1);
  }

  const normalizedBotUrl = botUrl.endsWith("/") ? botUrl.slice(0, -1) : botUrl;
  const url = `${normalizedBotUrl}/api/reminders/trigger`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${secret}`
    }
  });
  const body = await response.json().catch(() => null);

  // eslint-disable-next-line no-console
  console.log(`Reminder trigger response: ${response.status}`, body);

  if (!response.ok) {
    process.exit(1);
  }
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(error);
  process.exit(1);
});
