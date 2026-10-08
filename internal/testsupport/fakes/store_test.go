package fakes_test

import (
	"testing"

	"github.com/bretperry/hussla/internal/app/store"
	"github.com/bretperry/hussla/internal/testsupport/fakes"
	"github.com/bretperry/hussla/internal/testsupport/storecontract"
)

func TestFakeStoreMeetsTheStorageContract(t *testing.T) {
	storecontract.Run(t, func(*testing.T) store.Store { return fakes.New() })
}
