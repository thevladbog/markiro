ALTER TABLE "support_chat_consents" ADD COLUMN "notice_locale" text;--> statement-breakpoint
ALTER TABLE "support_chat_consents" ADD COLUMN "notice_text" text;
--> statement-breakpoint
CREATE FUNCTION support_chat_consent_notice_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.notice_locale IS NULL OR NEW.notice_text IS NULL OR
     NEW.notice_version <> 'support-transcript-v1' OR
     NOT (
       (NEW.notice_locale = 'ru' AND NEW.notice_text = 'Переписка по этому вопросу будет добавлена в обращение. Её смогут читать владелец и администраторы вашей организации, а также поддержка Markiro. Новые сообщения этого диалога тоже будут добавляться') OR
       (NEW.notice_locale = 'en' AND NEW.notice_text = 'The conversation about this issue will be added to the support request. The owner and administrators of your organization, as well as Markiro support, will be able to read it. New messages in this conversation will also be added')
     ) THEN
    RAISE EXCEPTION 'support consent notice does not match canonical text'
      USING ERRCODE = '23514', CONSTRAINT = 'support_chat_consents_notice_exact';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER support_chat_consents_notice_exact
  BEFORE INSERT ON support_chat_consents
  FOR EACH ROW EXECUTE FUNCTION support_chat_consent_notice_guard();
