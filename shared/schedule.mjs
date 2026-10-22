// ES-module entry to shared/logic.js for the laptop server, the cloud function and the tests.
import './logic.js';

export const {
  merge3, mergeStates,
  prevSession, prevNote, charged, balance, pausesOf, pauseAt,
  TYPE, LEAD, DEFAULT_TZ, wallNow, startOf, dayKey, durOf, titleOf, remaining, reminderText, dayText, nextText, startText, isPaused, activeClients, attendanceView, applyAttendance, syncMakeup, RECEIPT_DAY, receiptsPeriod, receiptsSoFar, receiptsReport, textChunks, photoForms, forgetPhotos, deviceOf, loginPlace, dueMessages,
} = globalThis.DorozhkaLogic;
