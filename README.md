# CHS Courts Scheduling

A web-based reservation and management system for the six tennis courts at Chelmsford High School.

The project was created to make court scheduling easier to view, manage, and update while reducing booking conflicts and giving administrators tools to handle closures, priority access, and court availability.

## Features

- Public court schedule and reservation interface
- Shared booking data across users
- Six-court availability tracking
- Court status reporting for closures and reopenings
- Maintenance and priority-access scheduling
- Automatic handling of displaced reservations when possible
- Booking limits and duplicate-booking safeguards
- Player notifications and booking history
- Protected administrator portal
- Administrative cleanup and diagnostics tools
- Responsive interface for desktop and mobile use

## How it works

The public interface allows users to view court availability and create reservations. Booking information is stored in shared cloud storage so that changes remain synchronized across users.

Administrators have a separate protected dashboard for managing court availability, maintenance blocks, priority access, archived records, and other scheduling controls.

The application also includes safeguards for overlapping reservations, duplicate requests, unavailable courts, and scheduling conflicts.

## Technology

- HTML
- CSS
- JavaScript
- Cloudflare Pages
- Cloudflare Workers
- Cloudflare D1

## Project structure

The current application source is located in:

`2026-06-22/mak/`

That directory contains the public scheduling interface, administrator interface, deployment documentation, and project tests.

## Project status

This project is under continued development and testing. Features, interface design, and deployment configuration may continue to change as the system is refined.

## Purpose

The goal of the project is to turn a real scheduling problem into a usable software system that makes court reservations easier to organize for users while providing administrators with practical tools for maintaining the schedule.
